use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::settings::Settings;

const HEALTHY_AFTER: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

pub struct Paths {
    pub root: PathBuf,
    pub data: PathBuf,
    pub log: PathBuf,
}

struct Inner {
    settings: Settings,
    child: Option<Child>,
    started: Option<Instant>,
    retry_at: Option<Instant>,
    failures: u32,
    error: Option<String>,
    node: Option<PathBuf>,
    restart: bool,
    quitting: bool,
}

#[derive(Clone)]
pub struct Relay {
    inner: Arc<(Mutex<Inner>, Condvar)>,
    paths: Arc<Paths>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub error: Option<String>,
    pub node: Option<String>,
    pub log: String,
    pub log_tail: Vec<String>,
}

pub fn find_node(configured: &str) -> Option<PathBuf> {
    if !configured.trim().is_empty() {
        let p = PathBuf::from(configured.trim());
        return p.is_file().then_some(p);
    }
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let from_path = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .map(|dir| dir.join(exe));
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let fallbacks: Vec<PathBuf> = if cfg!(windows) {
        vec![PathBuf::from(r"C:\Program Files\nodejs\node.exe")]
    } else {
        let mut v = vec![PathBuf::from("/opt/homebrew/bin/node"), PathBuf::from("/usr/local/bin/node")];
        if let Some(home) = &home {
            v.push(home.join(".volta/bin/node"));
        }
        v
    };
    from_path.chain(fallbacks).find(|p| p.is_file())
}

fn tail(path: &Path, lines: usize) -> Vec<String> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].iter().map(|l| l.to_string()).collect()
}

fn backoff(failures: u32) -> Duration {
    Duration::from_secs(1u64 << failures.min(5)).min(MAX_BACKOFF)
}

impl Relay {
    pub fn start(settings: Settings, paths: Paths) -> Self {
        if let Some(dir) = paths.log.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = File::create(&paths.log);
        let relay = Self {
            inner: Arc::new((
                Mutex::new(Inner {
                    settings,
                    child: None,
                    started: None,
                    retry_at: None,
                    failures: 0,
                    error: None,
                    node: None,
                    restart: false,
                    quitting: false,
                }),
                Condvar::new(),
            )),
            paths: Arc::new(paths),
        };
        let worker = relay.clone();
        std::thread::spawn(move || worker.supervise());
        relay
    }

    pub fn settings(&self) -> Settings {
        self.inner.0.lock().unwrap().settings.clone()
    }

    pub fn restart_with(&self, settings: Settings) {
        let (lock, wake) = &*self.inner;
        let mut inner = lock.lock().unwrap();
        inner.settings = settings;
        inner.restart = true;
        wake.notify_all();
    }

    pub fn update(&self, settings: Settings) {
        self.inner.0.lock().unwrap().settings = settings;
    }

    pub fn stop(&self) {
        let (lock, wake) = &*self.inner;
        let mut inner = lock.lock().unwrap();
        inner.quitting = true;
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        wake.notify_all();
    }

    pub fn status(&self) -> RelayStatus {
        let inner = self.inner.0.lock().unwrap();
        RelayStatus {
            running: inner.child.is_some(),
            pid: inner.child.as_ref().map(|c| c.id()),
            error: inner.error.clone(),
            node: inner.node.as_ref().map(|p| p.display().to_string()),
            log: self.paths.log.display().to_string(),
            log_tail: tail(&self.paths.log, 30),
        }
    }

    pub fn root(&self) -> &Path {
        &self.paths.root
    }

    fn spawn(&self, inner: &mut Inner) -> Result<Child, String> {
        let node = find_node(&inner.settings.node_path).ok_or("Node.js wasn't found; set its path in Settings")?;
        inner.node = Some(node.clone());
        let script = self.paths.root.join("relay").join("server.mjs");
        if !script.is_file() {
            return Err(format!("relay not found at {}", script.display()));
        }
        let log = OpenOptions::new().create(true).append(true).open(&self.paths.log).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(node);
        cmd.arg(script)
            .args(inner.settings.relay_args())
            .arg("--data")
            .arg(&self.paths.data)
            .current_dir(&self.paths.root)
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd.spawn().map_err(|e| e.to_string())
    }

    fn supervise(&self) {
        let (lock, wake) = &*self.inner;
        let mut inner = lock.lock().unwrap();
        loop {
            if inner.quitting {
                return;
            }
            if inner.restart {
                inner.restart = false;
                if let Some(mut child) = inner.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                inner.failures = 0;
                inner.retry_at = None;
                inner.error = None;
            }
            if let Some(child) = inner.child.as_mut()
                && let Ok(Some(code)) = child.try_wait()
            {
                inner.child = None;
                let healthy = inner.started.is_some_and(|s| s.elapsed() > HEALTHY_AFTER);
                inner.failures = if healthy { 0 } else { inner.failures + 1 };
                let last = tail(&self.paths.log, 1).pop().unwrap_or_default();
                inner.error = Some(format!("The relay stopped ({code}). {last}").trim().to_owned());
                inner.retry_at = Some(Instant::now() + backoff(inner.failures));
            }
            let due = inner.retry_at.is_none_or(|at| Instant::now() >= at);
            if inner.child.is_none() && due {
                match self.spawn(&mut inner) {
                    Ok(child) => {
                        inner.child = Some(child);
                        inner.started = Some(Instant::now());
                        inner.retry_at = None;
                    }
                    Err(e) => {
                        inner.failures += 1;
                        inner.error = Some(e);
                        inner.retry_at = Some(Instant::now() + backoff(inner.failures));
                    }
                }
            }
            inner = wake.wait_timeout(inner, Duration::from_millis(500)).unwrap().0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff(0), Duration::from_secs(1));
        assert_eq!(backoff(3), Duration::from_secs(8));
        assert_eq!(backoff(10), MAX_BACKOFF);
    }
}

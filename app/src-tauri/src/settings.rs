use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub role: Role,
    pub forward_url: String,
    pub port: u16,
    pub summaries: bool,
    pub roku_ips: String,
    pub quiet_hours: String,
    pub notifications: bool,
    pub start_on_login: bool,
    pub node_path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Main,
    Forward,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            role: Role::Main,
            forward_url: String::new(),
            port: 8790,
            summaries: true,
            roku_ips: String::new(),
            quiet_hours: String::new(),
            notifications: true,
            start_on_login: true,
            node_path: String::new(),
        }
    }
}

impl Settings {
    pub fn relay_args(&self) -> Vec<String> {
        let mut args = vec!["--verbose".to_owned(), "--port".to_owned(), self.port.to_string()];
        if !self.summaries {
            args.push("--no-summaries".to_owned());
        }
        let rokus = self.roku_ips.split([',', ' ']).filter(|ip| !ip.is_empty()).collect::<Vec<_>>().join(",");
        if !rokus.is_empty() {
            args.push("--roku".to_owned());
            args.push(rokus);
        }
        if !self.quiet_hours.trim().is_empty() {
            args.push("--quiet".to_owned());
            args.push(self.quiet_hours.trim().to_owned());
        }
        if self.role == Role::Forward && !self.forward_url.trim().is_empty() {
            args.push("--forward".to_owned());
            args.push(self.forward_url.trim().to_owned());
        }
        args
    }

    pub fn relay_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.port < 1024 {
            return Err("Pick a port from 1024 up".into());
        }
        if !self.quiet_hours.trim().is_empty() && !valid_quiet(self.quiet_hours.trim()) {
            return Err("Quiet hours should look like 22:00-07:00".into());
        }
        if self.role == Role::Forward {
            let url = self.forward_url.trim();
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err("The main relay address should start with http://".into());
            }
        }
        Ok(())
    }
}

fn valid_quiet(text: &str) -> bool {
    let time = |t: &str| {
        let (h, m) = t.trim().split_once(':')?;
        let (h, m) = (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?);
        (h < 24 && m < 60).then_some(h * 60 + m)
    };
    match text.split_once('-') {
        Some((from, to)) => matches!((time(from), time(to)), (Some(a), Some(b)) if a != b),
        None => false,
    }
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let p = path(app).ok_or("no config folder")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(p, text + "\n").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_take_defaults() {
        let s: Settings = serde_json::from_str(r#"{"port": 9000}"#).unwrap();
        assert_eq!(s.port, 9000);
        assert!(s.summaries);
        assert_eq!(s.role, Role::Main);
    }

    #[test]
    fn relay_args_follow_settings() {
        let s = Settings {
            role: Role::Forward,
            forward_url: " http://pc:8790 ".into(),
            summaries: false,
            roku_ips: "192.168.4.46, 192.168.4.47".into(),
            ..Settings::default()
        };
        assert_eq!(
            s.relay_args(),
            ["--verbose", "--port", "8790", "--no-summaries", "--roku", "192.168.4.46,192.168.4.47", "--forward", "http://pc:8790"]
        );
    }

    #[test]
    fn quiet_hours_are_checked() {
        assert!(valid_quiet("22:00-07:00"));
        assert!(valid_quiet("12:30 - 13:00"));
        assert!(!valid_quiet("22-7"));
        assert!(!valid_quiet("25:00-07:00"));
        assert!(!valid_quiet("08:00-08:00"));
        let s = Settings { quiet_hours: "22:00-07:00".into(), ..Settings::default() };
        assert!(s.relay_args().ends_with(&["--quiet".to_owned(), "22:00-07:00".to_owned()]));
    }

    #[test]
    fn forward_needs_a_url() {
        let s = Settings { role: Role::Forward, ..Settings::default() };
        assert!(s.validate().is_err());
    }
}

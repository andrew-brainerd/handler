use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::image::Image;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::relay::Relay;
use crate::tv::{self, Screen, Tv};

const POLL: Duration = Duration::from_secs(2);
const ASK_EVERY: Duration = Duration::from_secs(60 * 60);

#[derive(Deserialize)]
struct Status {
    sessions: Vec<Session>,
    #[serde(default)]
    quiet: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    id: String,
    project: Option<String>,
    state: String,
    detail: Option<String>,
    question: Option<Question>,
    since: String,
    needs_you: bool,
}

#[derive(Deserialize)]
struct Question {
    text: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Light {
    Off,
    Idle,
    Working,
    NeedsYou(usize),
}

pub fn light(sessions: &[(bool, &str)], reachable: bool) -> Light {
    if !reachable {
        return Light::Off;
    }
    let needs = sessions.iter().filter(|(needs, _)| *needs).count();
    if needs > 0 {
        Light::NeedsYou(needs)
    } else if sessions.iter().any(|(_, state)| *state == "working") {
        Light::Working
    } else {
        Light::Idle
    }
}

fn icon_bytes(light: Light) -> &'static [u8] {
    match light {
        Light::Off => include_bytes!("../icons/tray/off.png"),
        Light::Idle => include_bytes!("../icons/tray/idle.png"),
        Light::Working => include_bytes!("../icons/tray/working.png"),
        Light::NeedsYou(1) => include_bytes!("../icons/tray/needs-1.png"),
        Light::NeedsYou(2) => include_bytes!("../icons/tray/needs-2.png"),
        Light::NeedsYou(3) => include_bytes!("../icons/tray/needs-3.png"),
        Light::NeedsYou(4) => include_bytes!("../icons/tray/needs-4.png"),
        Light::NeedsYou(5) => include_bytes!("../icons/tray/needs-5.png"),
        Light::NeedsYou(6) => include_bytes!("../icons/tray/needs-6.png"),
        Light::NeedsYou(7) => include_bytes!("../icons/tray/needs-7.png"),
        Light::NeedsYou(8) => include_bytes!("../icons/tray/needs-8.png"),
        Light::NeedsYou(9) => include_bytes!("../icons/tray/needs-9.png"),
        Light::NeedsYou(_) => include_bytes!("../icons/tray/needs-many.png"),
    }
}

pub fn tooltip(light: Light, working: usize) -> String {
    match light {
        Light::Off => "Tally: relay not running".into(),
        Light::Idle => "Tally: nothing running".into(),
        Light::Working => format!("Tally: {working} working"),
        Light::NeedsYou(n) => format!("Tally: {n} need{} you", if n == 1 { "s" } else { "" }),
    }
}

fn headline(s: &Session) -> (String, String) {
    let project = s.project.clone().unwrap_or_else(|| "A session".into());
    let title = match s.state.as_str() {
        "asking" => format!("{project} has a question"),
        "needs_permission" => format!("{project} needs permission"),
        _ => format!("{project} needs you"),
    };
    let body = s.question.as_ref().and_then(|q| q.text.clone()).or_else(|| s.detail.clone()).unwrap_or_default();
    (title, body)
}

pub fn set_light(app: &AppHandle, light: Light, working: usize) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(icon) = Image::from_bytes(icon_bytes(light)) {
            let _ = tray.set_icon(Some(icon));
        }
        let _ = tray.set_tooltip(Some(tooltip(light, working)));
    }
}

#[cfg(windows)]
fn app_id(app: &AppHandle) -> String {
    let built = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.ends_with("target/debug") || d.ends_with("target/release")))
        .unwrap_or(false);
    if built { tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_owned() } else { app.config().identifier.clone() }
}

#[cfg(windows)]
fn ask(app: &AppHandle, tvs: Vec<Tv>) {
    use tauri_winrt_notification::{Scenario, Toast};
    let (title, body) = tv::question(&tvs);
    let handle = Some(app.clone());
    let shown = Toast::new(&app_id(app))
        .title(&title)
        .text1(&body)
        .scenario(Scenario::Reminder)
        .add_button("Show on TV", "show")
        .add_button("Not now", "later")
        .on_activated(move |action| {
            if let Some(app) = handle.as_ref() {
                app.state::<Relay>().note(&format!("tv prompt answered: {}", action.as_deref().unwrap_or("-")));
            }
            if action.as_deref() == Some("show") {
                for tv in &tvs {
                    let _ = tv::show(tv);
                }
            }
            Ok(())
        })
        .show();
    let relay = app.state::<Relay>();
    match shown {
        Ok(()) => relay.note(&format!("asked: {title}")),
        Err(err) => relay.note(&format!("tv prompt failed: {err}")),
    }
}

#[cfg(not(windows))]
fn ask(_app: &AppHandle, _tvs: Vec<Tv>) {}

pub fn elsewhere(ips: &[String]) -> Vec<Tv> {
    ips.iter().map(|ip| tv::check(ip)).filter(|t| matches!(t.screen, Screen::Off | Screen::Other(_))).collect()
}

pub fn show_everywhere(ips: Vec<String>) {
    std::thread::spawn(move || {
        for tv in elsewhere(&ips) {
            let _ = tv::show(&tv);
        }
    });
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(3)).build();
        let mut shown: Option<(Light, usize)> = None;
        let mut seen: Option<HashSet<String>> = None;
        let mut was_working: Option<bool> = None;
        let mut asked: Option<Instant> = None;
        loop {
            let relay = app.state::<Relay>();
            let settings = relay.settings();
            let status: Option<Status> = agent
                .get(&format!("{}/status", settings.relay_url()))
                .call()
                .ok()
                .and_then(|res| res.into_json().ok());
            let sessions = status.as_ref().map(|s| s.sessions.as_slice()).unwrap_or_default();
            let pairs: Vec<(bool, &str)> = sessions.iter().map(|s| (s.needs_you, s.state.as_str())).collect();
            let now = light(&pairs, status.is_some());
            let working = pairs.iter().filter(|(_, state)| *state == "working").count();
            if shown != Some((now, working)) {
                set_light(&app, now, working);
                shown = Some((now, working));
            }
            if let Some(status) = &status {
                let keys: HashSet<String> =
                    status.sessions.iter().filter(|s| s.needs_you).map(|s| format!("{}|{}", s.id, s.since)).collect();
                if let Some(before) = &seen
                    && settings.notifications
                {
                    for s in status.sessions.iter().filter(|s| s.needs_you) {
                        if !before.contains(&format!("{}|{}", s.id, s.since)) {
                            let (title, body) = headline(s);
                            let _ = app.notification().builder().title(title).body(body).show();
                        }
                    }
                }
                seen = Some(keys);
                let started = working > 0 && was_working == Some(false);
                was_working = Some(working > 0);
                let ips = tv::ips(&settings.roku_ips);
                if started && settings.ask_tv && !status.quiet && !ips.is_empty() && asked.is_none_or(|t| t.elapsed() > ASK_EVERY) {
                    let tvs = elsewhere(&ips);
                    if !tvs.is_empty() {
                        asked = Some(Instant::now());
                        ask(&app, tvs);
                    }
                }
            }
            std::thread::sleep(POLL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn light_prefers_needs_you_then_working() {
        assert_eq!(light(&[], false), Light::Off);
        assert_eq!(light(&[], true), Light::Idle);
        assert_eq!(light(&[(false, "waiting"), (false, "working")], true), Light::Working);
        assert_eq!(light(&[(true, "asking"), (false, "working"), (true, "needs_permission")], true), Light::NeedsYou(2));
    }

    #[test]
    fn tooltip_counts() {
        assert_eq!(tooltip(Light::NeedsYou(1), 0), "Tally: 1 needs you");
        assert_eq!(tooltip(Light::NeedsYou(3), 0), "Tally: 3 need you");
    }
}

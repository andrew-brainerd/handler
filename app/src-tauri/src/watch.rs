use std::collections::HashSet;
use std::time::Duration;

use serde::Deserialize;
use tauri::image::Image;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::relay::Relay;

const POLL: Duration = Duration::from_secs(2);

#[derive(Deserialize)]
struct Status {
    sessions: Vec<Session>,
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

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(3)).build();
        let mut shown: Option<(Light, usize)> = None;
        let mut seen: Option<HashSet<String>> = None;
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

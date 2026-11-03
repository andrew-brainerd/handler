use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const DEFAULT_PORT: u16 = 8790;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub role: Role,
    pub forward_url: String,
    pub forward_host: String,
    pub port: u16,
    pub summaries: bool,
    pub roku_ips: String,
    pub quiet_hours: String,
    pub notifications: bool,
    pub ask_tv: bool,
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
            forward_host: String::new(),
            port: DEFAULT_PORT,
            summaries: true,
            roku_ips: String::new(),
            quiet_hours: String::new(),
            notifications: true,
            ask_tv: true,
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
        if self.role == Role::Forward {
            let url = normalize_url(&self.forward_url);
            if !url.is_empty() {
                args.push("--forward".to_owned());
                args.push(url);
            } else if !self.forward_host.trim().is_empty() {
                args.push("--forward-host".to_owned());
                args.push(self.forward_host.trim().to_owned());
            }
        }
        args
    }

    pub fn relay_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn normalized(mut self) -> Self {
        self.forward_url = normalize_url(&self.forward_url);
        self.forward_host = self.forward_host.trim().to_owned();
        self
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
            if url.is_empty() && self.forward_host.trim().is_empty() {
                return Err("Pick a main relay, or enter its address".into());
            }
            if url.contains(char::is_whitespace) {
                return Err("The main relay address can't contain spaces".into());
            }
        }
        Ok(())
    }
}

fn normalize_url(input: &str) -> String {
    let text = input.trim().trim_end_matches('/');
    if text.is_empty() {
        return String::new();
    }
    let (scheme, rest) = text.split_once("://").unwrap_or(("http", text));
    if scheme == "http" && !rest.contains(':') {
        return format!("http://{rest}:{DEFAULT_PORT}");
    }
    format!("{scheme}://{rest}")
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
    fn forward_needs_a_main_relay() {
        let s = Settings { role: Role::Forward, ..Settings::default() };
        assert!(s.validate().is_err());
        assert!(Settings { forward_host: "PC".into(), ..s.clone() }.validate().is_ok());
        assert!(Settings { forward_url: "192.168.4.55".into(), ..s.clone() }.validate().is_ok());
        assert!(Settings { forward_url: "my pc".into(), ..s }.validate().is_err());
    }

    #[test]
    fn addresses_fill_in_what_is_missing() {
        assert_eq!(normalize_url(" 192.168.4.55 "), "http://192.168.4.55:8790");
        assert_eq!(normalize_url("http://192.168.4.55"), "http://192.168.4.55:8790");
        assert_eq!(normalize_url("http://192.168.4.55/"), "http://192.168.4.55:8790");
        assert_eq!(normalize_url("192.168.4.55:9000"), "http://192.168.4.55:9000");
        assert_eq!(normalize_url("http://pc:9000"), "http://pc:9000");
        assert_eq!(normalize_url("https://relay.example"), "https://relay.example");
        assert_eq!(normalize_url("  "), "");
    }

    #[test]
    fn a_picked_main_is_followed_by_name_and_an_address_wins() {
        let s = Settings { role: Role::Forward, forward_host: "PC".into(), ..Settings::default() };
        assert!(s.relay_args().ends_with(&["--forward-host".to_owned(), "PC".to_owned()]));
        let s = Settings { forward_url: "10.0.0.2".into(), ..s };
        assert!(s.relay_args().ends_with(&["--forward".to_owned(), "http://10.0.0.2:8790".to_owned()]));
        let main = Settings { role: Role::Main, ..s };
        assert!(!main.relay_args().iter().any(|a| a.starts_with("--forward")));
    }
}

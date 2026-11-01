use std::time::Duration;

const CHANNEL: &str = "dev";
const WAKE: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Screen {
    Tally,
    Off,
    Other(String),
    Unreachable,
}

#[derive(Clone, Debug)]
pub struct Tv {
    pub ip: String,
    pub name: String,
    pub screen: Screen,
}

fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let start = xml.find(&format!("<{name}"))?;
    let rest = &xml[start..];
    let open = rest.find('>')?;
    if rest[..open].ends_with('/') {
        return Some("");
    }
    let close = rest.find(&format!("</{name}>"))?;
    Some(rest[open + 1..close].trim())
}

fn attr<'a>(xml: &'a str, name: &str, key: &str) -> Option<&'a str> {
    let start = xml.find(&format!("<{name}"))?;
    let head = &xml[start..start + xml[start..].find('>')?];
    let at = head.find(&format!("{key}=\""))? + key.len() + 2;
    Some(&head[at..at + head[at..].find('"')?])
}

pub fn read_screen(device_info: &str, active_app: &str) -> Screen {
    if tag(device_info, "power-mode").is_some_and(|mode| mode != "PowerOn") {
        return Screen::Off;
    }
    if attr(active_app, "app", "id") == Some(CHANNEL) || attr(active_app, "screensaver", "id") == Some(CHANNEL) {
        return Screen::Tally;
    }
    if attr(active_app, "app", "type") == Some("home") || tag(active_app, "app") == Some("Roku") {
        return Screen::Other("the home screen".into());
    }
    Screen::Other(tag(active_app, "app").filter(|a| !a.is_empty()).unwrap_or("something else").to_owned())
}

pub fn ips(list: &str) -> Vec<String> {
    list.split([',', ' ']).map(str::trim).filter(|ip| !ip.is_empty()).map(str::to_owned).collect()
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(3)).build()
}

fn get(agent: &ureq::Agent, ip: &str, path: &str) -> Option<String> {
    agent.get(&format!("http://{ip}:8060/{path}")).call().ok()?.into_string().ok()
}

fn post(agent: &ureq::Agent, ip: &str, path: &str) -> Result<(), String> {
    agent.post(&format!("http://{ip}:8060/{path}")).call().map(|_| ()).map_err(|e| e.to_string())
}

pub fn check(ip: &str) -> Tv {
    let agent = agent();
    let info = get(&agent, ip, "query/device-info");
    let name = info.as_deref().and_then(|i| tag(i, "friendly-device-name")).filter(|n| !n.is_empty()).unwrap_or(ip).to_owned();
    let screen = match (info, get(&agent, ip, "query/active-app")) {
        (Some(info), Some(app)) => read_screen(&info, &app),
        (Some(info), None) if tag(&info, "power-mode").is_some_and(|m| m != "PowerOn") => Screen::Off,
        _ => Screen::Unreachable,
    };
    Tv { ip: ip.to_owned(), name, screen }
}

pub fn show(tv: &Tv) -> Result<(), String> {
    let agent = agent();
    if tv.screen == Screen::Off {
        post(&agent, &tv.ip, "keypress/PowerOn")?;
        std::thread::sleep(WAKE);
    }
    post(&agent, &tv.ip, &format!("launch/{CHANNEL}"))
}

pub fn question(tvs: &[Tv]) -> (String, String) {
    let names: Vec<&str> = tvs.iter().map(|t| t.name.as_str()).collect();
    let title = format!("Show Tally on the {}?", names.join(" and "));
    let body = tvs
        .iter()
        .map(|t| match &t.screen {
            Screen::Off => format!("The {} is off.", t.name),
            Screen::Other(app) => format!("The {} is showing {app}.", t.name),
            _ => String::new(),
        })
        .collect::<Vec<_>>()
        .join(" ");
    (title, format!("{body} An agent just started working."))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON: &str = "<device-info>\n\t<friendly-device-name>Office TV</friendly-device-name>\n\t<power-mode>PowerOn</power-mode>\n</device-info>";
    const STANDBY: &str = "<device-info>\n\t<power-mode>DisplayOff</power-mode>\n</device-info>";

    #[test]
    fn reads_what_the_tv_shows() {
        let tally = r#"<active-app><app id="dev" type="appl" version="0.1.1">Tally</app></active-app>"#;
        let home = "<active-app>\n\t<app>Roku</app>\n</active-app>";
        let netflix = r#"<active-app><app id="12" type="appl">Netflix</app></active-app>"#;
        let saver = r#"<active-app><app>Roku</app><screensaver id="dev" type="ssvr">Tally</screensaver></active-app>"#;
        assert_eq!(read_screen(ON, tally), Screen::Tally);
        assert_eq!(read_screen(ON, saver), Screen::Tally);
        assert_eq!(read_screen(ON, home), Screen::Other("the home screen".into()));
        let dynamic = r#"<active-app><app id="562859" type="home" ui-location="home">Roku Dynamic Menu</app></active-app>"#;
        assert_eq!(read_screen(ON, dynamic), Screen::Other("the home screen".into()));
        assert_eq!(read_screen(ON, netflix), Screen::Other("Netflix".into()));
        assert_eq!(read_screen(STANDBY, tally), Screen::Off);
        assert_eq!(tag(ON, "friendly-device-name"), Some("Office TV"));
    }

    #[test]
    fn asks_in_plain_words() {
        let tv = |name: &str, screen| Tv { ip: String::new(), name: name.into(), screen };
        let (title, body) = question(&[tv("Office TV", Screen::Other("Netflix".into()))]);
        assert_eq!(title, "Show Tally on the Office TV?");
        assert_eq!(body, "The Office TV is showing Netflix. An agent just started working.");
        let (title, _) = question(&[tv("Office TV", Screen::Off), tv("Den TV", Screen::Off)]);
        assert_eq!(title, "Show Tally on the Office TV and Den TV?");
        assert_eq!(ips("192.168.4.46, 10.0.0.2"), vec!["192.168.4.46", "10.0.0.2"]);
    }
}

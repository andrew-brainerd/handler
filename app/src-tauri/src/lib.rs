mod relay;
mod settings;
mod tv;
mod watch;
#[allow(dead_code)]
mod desk;

use std::path::PathBuf;
use std::process::Command;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::ManagerExt;

use relay::{Paths, Relay, RelayStatus};
use settings::Settings;

const BACKGROUND_ARG: &str = "--background";
const SETTINGS_ARG: &str = "--settings";

fn page_from(args: &[String]) -> &'static str {
    if args.iter().any(|a| a == SETTINGS_ARG) { "settings" } else { "board" }
}

struct PauseItem(CheckMenuItem<Wry>);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct View {
    settings: Settings,
    relay_url: String,
    relay: RelayStatus,
}

fn view(relay: &Relay) -> View {
    let settings = relay.settings();
    View { relay_url: settings.relay_url(), settings, relay: relay.status() }
}

fn apply_start_on_login(app: &AppHandle, enabled: bool) {
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    if let Err(e) = result {
        eprintln!("Handler start on login failed: {e}");
    }
}

fn store(app: &AppHandle, next: Settings) -> Result<(), String> {
    let next = next.normalized();
    next.validate()?;
    let relay = app.state::<Relay>();
    let before = relay.settings();
    settings::save(app, &next)?;
    if before.start_on_login != next.start_on_login {
        apply_start_on_login(app, next.start_on_login);
    }
    let _ = app.state::<PauseItem>().0.set_checked(!next.notifications);
    if before.relay_args() != next.relay_args() || before.node_path != next.node_path {
        relay.restart_with(next);
    } else {
        relay.update(next);
    }
    let _ = app.emit("changed", view(&relay));
    Ok(())
}

#[tauri::command]
fn state(relay: tauri::State<Relay>) -> View {
    view(&relay)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<View, String> {
    store(&app, settings)?;
    Ok(view(&app.state::<Relay>()))
}

#[tauri::command]
fn restart_relay(relay: tauri::State<Relay>) {
    relay.restart_with(relay.settings());
}

#[tauri::command]
fn hooks(relay: tauri::State<Relay>, install: bool) -> Result<String, String> {
    let settings = relay.settings();
    let node = relay::find_node(&settings.node_path).ok_or("Node.js wasn't found")?;
    let mut cmd = Command::new(node);
    cmd.arg(relay.root().join("scripts").join("hooks.mjs")).arg(if install { "install" } else { "uninstall" });
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_owned();
    if out.status.success() { Ok(text) } else { Err(text) }
}

fn reveal(app: &AppHandle, page: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("show-page", page);
        let _ = window.set_skip_taskbar(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn tray(app: &tauri::App, saved: &Settings) -> tauri::Result<()> {
    let board = MenuItem::with_id(app, "board", "Open board", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let show_tv = MenuItem::with_id(app, "tv", "Show on TV", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause notifications", true, !saved.notifications, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Handler", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&board, &show_tv, &settings, &pause, &PredefinedMenuItem::separator(app)?, &quit])?;
    TrayIconBuilder::with_id("main")
        .tooltip("Handler")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "board" => reveal(app, "board"),
            "settings" => reveal(app, "settings"),
            "tv" => watch::show_everywhere(tv::ips(&app.state::<Relay>().settings().roku_ips)),
            "pause" => {
                let paused = app.state::<PauseItem>().0.is_checked().unwrap_or(false);
                let next = Settings { notifications: !paused, ..app.state::<Relay>().settings() };
                let _ = store(app, next);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                reveal(tray.app_handle(), "board");
            }
        })
        .build(app)?;
    watch::set_light(app.handle(), watch::Light::Off, 0);
    app.manage(PauseItem(pause));
    Ok(())
}

fn root(app: &AppHandle) -> PathBuf {
    if tauri::is_dev() {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
    } else {
        plain_path(app.path().resource_dir().unwrap_or_default())
    }
}

fn plain_path(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefix_is_dropped() {
        assert_eq!(plain_path(PathBuf::from(r"\\?\C:\Users\a\Handler")), PathBuf::from(r"C:\Users\a\Handler"));
        assert_eq!(plain_path(PathBuf::from(r"\\?\UNC\srv\share")), PathBuf::from(r"\\?\UNC\srv\share"));
        assert_eq!(plain_path(PathBuf::from("/Applications/Handler.app")), PathBuf::from("/Applications/Handler.app"));
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| reveal(app, page_from(&args))))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![BACKGROUND_ARG]),
        ))
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![state, save_settings, restart_relay, hooks])
        .setup(|app| {
            let handle = app.handle();
            let saved = settings::load(handle);
            let paths = Paths {
                root: root(handle),
                data: plain_path(app.path().app_data_dir()?),
                log: app.path().app_log_dir()?.join("relay.log"),
            };
            app.manage(Relay::start(saved.clone(), paths));
            apply_start_on_login(handle, saved.start_on_login);
            tray(app, &saved)?;
            let args: Vec<String> = std::env::args().collect();
            let background = args.iter().any(|arg| arg == BACKGROUND_ARG);
            let start = format!("index.html#{}", page_from(&args));
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(start.into()))
                .title("Handler")
                .inner_size(1280.0, 800.0)
                .min_inner_size(720.0, 480.0)
                .background_color(tauri::window::Color(13, 15, 18, 255))
                .visible(false)
                .build()?;
            if !background {
                window.show()?;
            }
            watch::start(handle.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Handler")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<Relay>().stop();
            }
        });
}

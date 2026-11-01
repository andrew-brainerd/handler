use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub file: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub kind: Option<String>,
    pub body: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
    pub id: String,
    pub path: PathBuf,
    pub size: u64,
    pub modified: i64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub first_prompt: Option<String>,
    pub title: Option<String>,
    pub started: Option<String>,
    pub ended: Option<String>,
    pub messages: usize,
}

pub fn encode(path: &Path) -> String {
    path.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

pub fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

pub fn project_dir(claude_home: &Path, project: &Path) -> PathBuf {
    claude_home.join("projects").join(encode(project))
}

fn front_value<'a>(front: &'a str, key: &str) -> Option<&'a str> {
    front.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim() == key).then(|| v.trim().trim_matches('"'))
    })
}

pub fn parse_memory(file: &str, text: &str) -> Memory {
    let text = text.replace("\r\n", "\n");
    let (front, body) = match text.strip_prefix("---\n").and_then(|rest| rest.split_once("\n---")) {
        Some((front, body)) => (front.to_owned(), body.trim_start_matches(['-', '\n']).to_owned()),
        None => (String::new(), text.clone()),
    };
    Memory {
        file: file.to_owned(),
        name: front_value(&front, "name").map(str::to_owned),
        description: front_value(&front, "description").map(str::to_owned),
        kind: front_value(&front, "type").map(str::to_owned),
        body: body.trim().to_owned(),
    }
}

pub fn memories(claude_home: &Path, project: &Path) -> Vec<Memory> {
    let dir = project_dir(claude_home, project).join("memory");
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut list: Vec<Memory> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            std::fs::read_to_string(e.path()).ok().map(|t| parse_memory(&name, &t))
        })
        .collect();
    list.sort_by(|a, b| a.file.cmp(&b.file));
    list
}

pub fn sessions(claude_home: &Path, project: &Path) -> Vec<SessionFile> {
    let dir = project_dir(claude_home, project);
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut list: Vec<SessionFile> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
            Some(SessionFile {
                id: e.path().file_stem()?.to_string_lossy().into_owned(),
                path: e.path(),
                size: meta.len(),
                modified,
            })
        })
        .collect();
    list.sort_by(|a, b| b.modified.cmp(&a.modified));
    list
}

fn prompt_text(entry: &serde_json::Value) -> Option<String> {
    let content = &entry["message"]["content"];
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(" "),
        _ => return None,
    };
    let text = text.trim();
    let injected = text.starts_with('<') || text.is_empty();
    (!injected).then(|| text.chars().take(300).collect())
}

pub fn session_info(path: &Path) -> SessionInfo {
    let mut info = SessionInfo::default();
    let Ok(file) = std::fs::File::open(path) else { return info };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if let Some(t) = entry["timestamp"].as_str() {
            info.started.get_or_insert_with(|| t.to_owned());
            info.ended = Some(t.to_owned());
        }
        match entry["type"].as_str() {
            Some("ai-title") => info.title = entry["aiTitle"].as_str().map(str::to_owned),
            Some("user") if entry["isMeta"] != true && entry["isSidechain"] != true => {
                if let Some(text) = prompt_text(&entry) {
                    info.messages += 1;
                    info.first_prompt.get_or_insert(text);
                }
            }
            Some("assistant") => info.messages += 1,
            _ => {}
        }
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_encode_like_claude_code() {
        assert_eq!(encode(Path::new(r"C:\Users\drwb3")), "C--Users-drwb3");
        assert_eq!(encode(Path::new(r"C:\projects\brainerd-api")), "C--projects-brainerd-api");
        assert_eq!(encode(Path::new("/Users/andrew/my.app")), "-Users-andrew-my-app");
    }

    #[test]
    fn memory_front_matter() {
        let m = parse_memory("x.md", "---\r\nname: tally-state\r\ndescription: \"Tally board\"\r\nmetadata:\r\n  type: project\r\n---\r\n\r\nBody text.\r\n");
        assert_eq!(m.name.as_deref(), Some("tally-state"));
        assert_eq!(m.description.as_deref(), Some("Tally board"));
        assert_eq!(m.kind.as_deref(), Some("project"));
        assert_eq!(m.body, "Body text.");
    }

    #[test]
    fn session_info_from_a_transcript() {
        let dir = std::env::temp_dir().join(format!("tally-desk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let lines = [
            r#"{"type":"user","isMeta":true,"timestamp":"2026-11-01T01:00:00Z","message":{"content":"<command>x</command>"}}"#,
            r#"{"type":"user","timestamp":"2026-11-01T01:00:01Z","message":{"content":[{"type":"text","text":"build the tray app"}]}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-01T01:00:05Z","message":{"content":[]}}"#,
            r#"{"type":"ai-title","aiTitle":"Tray app"}"#,
            "not json",
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        let info = session_info(&path);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(info.first_prompt.as_deref(), Some("build the tray app"));
        assert_eq!(info.title.as_deref(), Some("Tray app"));
        assert_eq!(info.started.as_deref(), Some("2026-11-01T01:00:00Z"));
        assert_eq!(info.ended.as_deref(), Some("2026-11-01T01:00:05Z"));
        assert_eq!(info.messages, 2);
    }
}

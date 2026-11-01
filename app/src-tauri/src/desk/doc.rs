use std::collections::BTreeMap;

use serde::Serialize;

pub const ID_PREFIXES: &[&str] = &["US", "AC", "FR", "NFR", "OQ"];

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontMatter {
    pub name: Option<String>,
    pub status: Option<String>,
    pub version: Option<String>,
    pub last_updated: Option<String>,
    pub targets: Vec<String>,
    pub companion: Option<String>,
    pub other: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Heading {
    pub level: usize,
    pub text: String,
    pub line: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct Phase {
    pub title: String,
    pub line: usize,
    pub status: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct IdDef {
    pub id: String,
    pub line: usize,
    pub text: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    pub front: FrontMatter,
    pub title: Option<String>,
    pub outline: Vec<Heading>,
    pub resume: Option<String>,
    pub phases: Vec<Phase>,
    pub ids: Vec<IdDef>,
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    let quoted = v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')));
    if quoted { v[1..v.len() - 1].to_owned() } else { v.to_owned() }
}

fn front_matter(lines: &[&str]) -> (FrontMatter, usize) {
    let mut front = FrontMatter::default();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return (front, 0);
    }
    let Some(end) = lines.iter().skip(1).position(|l| l.trim() == "---").map(|i| i + 1) else {
        return (front, 0);
    };
    let mut list_key: Option<String> = None;
    let mut lists: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for line in &lines[1..end] {
        let trimmed = line.trim();
        if let Some(item) = trimmed.strip_prefix("- ")
            && let Some(key) = &list_key
        {
            lists.entry(key.clone()).or_default().push(unquote(item));
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        if key.starts_with(' ') || key.trim().is_empty() {
            continue;
        }
        let key = key.trim().to_owned();
        let value = value.trim();
        if value.is_empty() {
            list_key = Some(key);
            continue;
        }
        list_key = None;
        if let Some(inner) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
            lists.insert(key, inner.split(',').map(unquote).filter(|s| !s.is_empty()).collect());
            continue;
        }
        let value = unquote(value);
        match key.as_str() {
            "name" => front.name = Some(value),
            "status" => front.status = Some(value),
            "version" => front.version = Some(value),
            "last_updated" => front.last_updated = Some(value),
            "companion" => front.companion = Some(value),
            "targets" => front.targets = vec![value],
            _ => {
                front.other.insert(key, value);
            }
        }
    }
    for (key, items) in lists {
        match key.as_str() {
            "targets" => front.targets = items,
            "companion" => front.companion = items.into_iter().next(),
            _ => {
                front.other.insert(key, items.join(", "));
            }
        }
    }
    (front, end + 1)
}

pub fn id_at_start(text: &str, prefixes: &[&str]) -> Option<String> {
    let rest = text.trim_start_matches(|c: char| c == '#' || c == '-' || c == '*' || c == ' ' || c == '`');
    let (prefix, after) = prefixes.iter().find_map(|p| rest.strip_prefix(p).and_then(|a| a.strip_prefix('-')).map(|a| (*p, a)))?;
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let mut id = format!("{prefix}-{digits}");
    let mut tail = &after[digits.len()..];
    if let Some(sub) = tail.strip_prefix('.') {
        let sub_digits: String = sub.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !sub_digits.is_empty() {
            id = format!("{id}.{sub_digits}");
            tail = &sub[sub_digits.len()..];
        }
    }
    if let Some(c) = tail.chars().next()
        && c.is_ascii_lowercase()
        && !tail.chars().nth(1).is_some_and(|n| n.is_ascii_alphanumeric())
    {
        id.push(c);
        tail = &tail[1..];
    }
    match tail.chars().next() {
        Some(c) if c.is_ascii_alphanumeric() || c == '-' || c == '.' => None,
        _ => Some(id),
    }
}

fn is_resume(text: &str) -> bool {
    text.to_lowercase().contains("resume notes")
}

fn phase_title(text: &str) -> Option<String> {
    let t = text.trim();
    t.to_lowercase().starts_with("phase ").then(|| t.to_owned())
}

fn status_line(line: &str) -> Option<String> {
    let t = line.trim().trim_start_matches(['-', '*', ' ']);
    let lower = t.to_lowercase();
    let rest = if lower.starts_with("status**:") {
        &t["status**:".len()..]
    } else if lower.starts_with("**status**:") {
        &t["**status**:".len()..]
    } else if lower.starts_with("status:") {
        &t["status:".len()..]
    } else {
        return None;
    };
    Some(rest.trim().to_owned())
}

pub fn parse(text: &str) -> Doc {
    parse_with(text, ID_PREFIXES)
}

pub fn parse_with(text: &str, prefixes: &[&str]) -> Doc {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = text.lines().map(|l| l.trim_end_matches('\r')).collect();
    let (front, body_start) = front_matter(&lines);
    let mut doc = Doc { front, ..Doc::default() };
    let mut fenced = false;
    let mut resume: Option<(usize, Vec<&str>)> = None;
    let mut seen_ids = std::collections::HashSet::new();
    for (i, line) in lines.iter().enumerate().skip(body_start) {
        let number = i + 1;
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
        }
        if fenced {
            if let Some((_, body)) = resume.as_mut() {
                body.push(line);
            }
            continue;
        }
        let hashes = line.chars().take_while(|c| *c == '#').count();
        let heading = (1..=6).contains(&hashes) && line[hashes..].starts_with(' ');
        if heading {
            let text = line[hashes..].trim().to_owned();
            if let Some((level, _)) = &resume
                && hashes <= *level
            {
                doc.resume = resume.take().map(|(_, body)| body.join("\n").trim().to_owned());
            }
            if hashes == 1 && doc.title.is_none() {
                doc.title = Some(text.clone());
            }
            if let Some((_, body)) = resume.as_mut() {
                body.push(line);
            } else if is_resume(&text) && doc.resume.is_none() {
                resume = Some((hashes, Vec::new()));
            }
            if let Some(title) = phase_title(&text) {
                doc.phases.push(Phase { title, line: number, status: None });
            }
            doc.outline.push(Heading { level: hashes, text, line: number });
        } else if let Some((_, body)) = resume.as_mut() {
            body.push(line);
        }
        if !heading
            && let Some(phase) = doc.phases.last_mut()
            && phase.status.is_none()
            && doc.outline.last().is_some_and(|h| h.line == phase.line)
            && let Some(status) = status_line(line)
        {
            phase.status = Some(status);
        }
        let candidate = if heading { &line[hashes..] } else { line };
        let listed = heading || line.trim_start().starts_with(['-', '*']);
        if listed
            && let Some(id) = id_at_start(candidate, prefixes)
            && seen_ids.insert(id.clone())
        {
            doc.ids.push(IdDef { id, line: number, text: line.trim().to_owned() });
        }
    }
    if let Some((_, body)) = resume {
        doc.resume = Some(body.join("\n").trim().to_owned());
    }
    doc
}

impl Doc {
    pub fn current_phase(&self) -> Option<&Phase> {
        let state = |p: &Phase| p.status.as_deref().unwrap_or("").to_lowercase();
        let done = |s: &str| s.starts_with("done") || s.starts_with("complete");
        let untouched = |s: &str| s.is_empty() || s.starts_with("not started");
        if self.phases.iter().all(|p| p.status.is_none()) {
            return None;
        }
        self.phases
            .iter()
            .find(|p| {
                let s = state(p);
                !done(&s) && !untouched(&s)
            })
            .or_else(|| self.phases.iter().find(|p| untouched(&state(p))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: &str = "---\r\nname: tally\r\nstatus: draft\r\nversion: 0.5.3\r\nlast_updated: \"2026-11-01\"\r\ntargets:\r\n  - C:\\projects\\tally\\relay\\** (relay)\r\n  - C:\\projects\\tally\\roku\\**\r\ntags: [a, b]\r\n---\r\n\r\n# Tally\r\n\r\n## §0 Resume notes (read this first)\r\n\r\n- **Current state:** relay built.\r\n\r\n### Detail\r\nmore\r\n\r\n## 1. Overview\r\n\r\n### US-07 — See my workspace\r\n- AC-07.1: First run asks.\r\n- **FR-22a** — Other sources.\r\n- **FR-13** — Relays.\r\nSee FR-13 for more.\r\n\r\n```\r\n## not a heading\r\n- FR-99 inside a fence\r\n```\r\n\r\n## 7. Phases\r\n### Phase A — Spike\r\n- A-1: do it\r\n- **status**: done (2026-10-30).\r\n### Phase B — Relay\r\n- **status**: B-1 done; B-2 in progress.\r\n### Phase C — Roku\r\n- **status**: not started.\r\n";

    #[test]
    fn front_matter_with_lists_and_crlf() {
        let doc = parse(SPEC);
        assert_eq!(doc.front.name.as_deref(), Some("tally"));
        assert_eq!(doc.front.version.as_deref(), Some("0.5.3"));
        assert_eq!(doc.front.last_updated.as_deref(), Some("2026-11-01"));
        assert_eq!(doc.front.targets.len(), 2);
        assert_eq!(doc.front.other.get("tags").map(String::as_str), Some("a, b"));
        assert_eq!(doc.title.as_deref(), Some("Tally"));
    }

    #[test]
    fn resume_notes_run_to_the_next_same_level_heading() {
        let doc = parse(SPEC);
        let resume = doc.resume.unwrap();
        assert!(resume.starts_with("- **Current state:** relay built."));
        assert!(resume.contains("### Detail"));
        assert!(!resume.contains("Overview"));
    }

    #[test]
    fn headings_skip_code_fences() {
        let doc = parse(SPEC);
        assert!(doc.outline.iter().all(|h| h.text != "not a heading"));
        assert!(doc.outline.iter().any(|h| h.level == 3 && h.text == "Phase B — Relay"));
    }

    #[test]
    fn ids_are_found_where_defined() {
        let doc = parse(SPEC);
        let ids: Vec<&str> = doc.ids.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, ["US-07", "AC-07.1", "FR-22a", "FR-13"]);
        assert!(doc.ids[3].text.starts_with("- **FR-13**"));
    }

    #[test]
    fn phases_and_current_phase() {
        let doc = parse(SPEC);
        let statuses: Vec<Option<&str>> = doc.phases.iter().map(|p| p.status.as_deref()).collect();
        assert_eq!(statuses, [Some("done (2026-10-30)."), Some("B-1 done; B-2 in progress."), Some("not started.")]);
        assert_eq!(doc.current_phase().unwrap().title, "Phase B — Relay");
    }

    #[test]
    fn id_matching_is_strict() {
        assert_eq!(id_at_start("- **FR-12** — x", ID_PREFIXES).as_deref(), Some("FR-12"));
        assert_eq!(id_at_start("### OQ-04 — x", ID_PREFIXES).as_deref(), Some("OQ-04"));
        assert_eq!(id_at_start("- FR-1x2", ID_PREFIXES), None);
        assert_eq!(id_at_start("- FREE-1", ID_PREFIXES), None);
        assert_eq!(id_at_start("- FR-", ID_PREFIXES), None);
    }

    #[test]
    fn no_status_lines_means_no_current_phase() {
        let doc = parse("## Phases\n### Phase A — x\n- A-1\n### Phase B — y\n");
        assert_eq!(doc.phases.len(), 2);
        assert!(doc.current_phase().is_none());
    }

    #[test]
    fn docs_without_front_matter_still_parse() {
        let doc = parse("# Notes\n\nJust text.\n");
        assert!(doc.front.name.is_none());
        assert_eq!(doc.title.as_deref(), Some("Notes"));
        assert!(doc.phases.is_empty());
    }
}

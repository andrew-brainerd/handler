use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Git {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub uncommitted: u32,
    pub last_commit: Option<Commit>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Commit {
    pub time: i64,
    pub subject: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub stack: Vec<String>,
}

fn git_cmd(dir: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn parse_status(text: &str) -> Git {
    let mut git = Git::default();
    for line in text.lines() {
        if let Some(head) = line.strip_prefix("## ") {
            let (names, counts) = match head.split_once(" [") {
                Some((n, c)) => (n, c.trim_end_matches(']')),
                None => (head, ""),
            };
            let (branch, upstream) = match names.split_once("...") {
                Some((b, u)) => (b, Some(u.to_owned())),
                None => (names, None),
            };
            let branch = branch.strip_prefix("No commits yet on ").unwrap_or(branch);
            git.branch = (!branch.contains(' ') && !branch.is_empty()).then(|| branch.to_owned());
            git.upstream = upstream;
            for part in counts.split(", ") {
                if let Some(n) = part.strip_prefix("ahead ") {
                    git.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix("behind ") {
                    git.behind = n.parse().unwrap_or(0);
                }
            }
        } else if !line.trim().is_empty() {
            git.uncommitted += 1;
        }
    }
    git
}

pub fn git(dir: &Path) -> Option<Git> {
    if !dir.join(".git").exists() {
        return None;
    }
    let mut git = parse_status(&git_cmd(dir, &["status", "--porcelain=v1", "-b"])?);
    git.last_commit = git_cmd(dir, &["log", "-1", "--format=%ct%x09%s"]).and_then(|out| {
        let (time, subject) = out.trim().split_once('\t')?;
        Some(Commit { time: time.parse().ok()?, subject: subject.to_owned() })
    });
    Some(git)
}

pub fn first_paragraph(markdown: &str) -> Option<String> {
    let mut para: Vec<&str> = Vec::new();
    let mut fenced = false;
    let mut front = markdown.trim_start().starts_with("---");
    for (i, raw) in markdown.lines().enumerate() {
        let line = raw.trim();
        if front {
            if i > 0 && line == "---" {
                front = false;
            }
            continue;
        }
        if line.starts_with("```") {
            fenced = !fenced;
            continue;
        }
        let skip = fenced || line.starts_with('#') || line.starts_with("![") || line.starts_with("[![") || line.starts_with('<') || line.starts_with('|') || line.starts_with('>');
        if line.is_empty() || skip {
            if !para.is_empty() {
                break;
            }
            continue;
        }
        para.push(line);
    }
    (!para.is_empty()).then(|| para.join(" "))
}

fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

pub fn readme(dir: &Path) -> Option<String> {
    ["README.md", "readme.md", "Readme.md"].iter().find_map(|n| read(&dir.join(n))).and_then(|t| first_paragraph(&t))
}

pub fn claude_md(dir: &Path) -> Option<String> {
    read(&dir.join("CLAUDE.md")).and_then(|t| first_paragraph(&t))
}

fn toml_value(text: &str, section: &str, key: &str) -> Option<String> {
    let mut inside = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            inside = t == format!("[{section}]");
            continue;
        }
        if inside
            && let Some((k, v)) = t.split_once('=')
            && k.trim() == key
        {
            return Some(v.trim().trim_matches('"').to_owned());
        }
    }
    None
}

pub fn manifest(dir: &Path) -> Manifest {
    let mut m = Manifest::default();
    let has = |p: &str| dir.join(p).exists();
    if let Some(pkg) = read(&dir.join("package.json")).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) {
        m.name = pkg["name"].as_str().map(str::to_owned);
        m.description = pkg["description"].as_str().map(str::to_owned);
        m.stack.push("Node".into());
    }
    for cargo in [dir.join("Cargo.toml"), dir.join("src-tauri").join("Cargo.toml")] {
        if let Some(text) = read(&cargo) {
            m.name = m.name.or_else(|| toml_value(&text, "package", "name"));
            m.description = m.description.or_else(|| toml_value(&text, "package", "description"));
            if !m.stack.contains(&"Rust".to_owned()) {
                m.stack.push("Rust".into());
            }
        }
    }
    let checks: [(&str, bool); 7] = [
        ("Tauri", has("src-tauri") || has("app/src-tauri")),
        ("Roku", has("manifest") && has("source")),
        ("Python", has("pyproject.toml") || has("requirements.txt")),
        ("Go", has("go.mod")),
        (".NET", std::fs::read_dir(dir).map(|d| d.flatten().any(|e| e.path().extension().is_some_and(|x| x == "csproj" || x == "sln"))).unwrap_or(false)),
        ("Swift", has("Package.swift") || has("project.yml")),
        ("Unity", has("ProjectSettings")),
    ];
    m.stack.extend(checks.iter().filter(|(_, yes)| *yes).map(|(name, _)| (*name).to_owned()));
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_with_upstream_and_changes() {
        let g = parse_status("## master...origin/master [ahead 2, behind 1]\n M a.rs\n?? b.rs\n");
        assert_eq!(g.branch.as_deref(), Some("master"));
        assert_eq!(g.upstream.as_deref(), Some("origin/master"));
        assert_eq!((g.ahead, g.behind, g.uncommitted), (2, 1, 2));
    }

    #[test]
    fn status_without_upstream() {
        let g = parse_status("## main\n");
        assert_eq!(g.branch.as_deref(), Some("main"));
        assert!(g.upstream.is_none());
        assert_eq!(g.uncommitted, 0);
        assert_eq!(parse_status("## No commits yet on main\n").branch.as_deref(), Some("main"));
        assert_eq!(parse_status("## HEAD (no branch)\n").branch, None);
        assert_eq!(parse_status("## ?? notes.csv\n").branch, None);
    }

    #[test]
    fn first_paragraph_skips_headings_badges_and_front_matter() {
        let md = "---\nname: x\n---\n# Title\n\n[![badge](x)](y)\n\nTally shows agent status\non a TV.\n\nSecond.";
        assert_eq!(first_paragraph(md).as_deref(), Some("Tally shows agent status on a TV."));
        assert_eq!(first_paragraph("# Only a heading\n"), None);
    }

    #[test]
    fn toml_reads_package_fields() {
        let t = "[package]\nname = \"tally\"\ndescription = \"Agent board\"\n\n[dependencies]\nname = \"nope\"\n";
        assert_eq!(toml_value(t, "package", "name").as_deref(), Some("tally"));
        assert_eq!(toml_value(t, "package", "description").as_deref(), Some("Agent board"));
    }
}

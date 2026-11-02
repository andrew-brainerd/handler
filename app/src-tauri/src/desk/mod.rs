pub mod claude_internals;
pub mod doc;
pub mod scan;
pub mod sources;

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocSummary {
    pub path: PathBuf,
    pub file: String,
    pub name: Option<String>,
    pub title: Option<String>,
    pub status: Option<String>,
    pub version: Option<String>,
    pub last_updated: Option<String>,
    pub phase: Option<doc::Phase>,
    pub has_resume: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub path: PathBuf,
    pub description: Option<String>,
    pub has_claude_md: bool,
    pub docs: Vec<DocSummary>,
    pub git: Option<sources::Git>,
    pub manifest: sources::Manifest,
    pub memories: usize,
    pub sessions: usize,
    pub last_session: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub projects: Vec<Project>,
    pub other_docs: Vec<DocSummary>,
}

struct ParsedDoc {
    summary: DocSummary,
    targets: Vec<String>,
}

fn parse_doc(path: &Path) -> Option<ParsedDoc> {
    let text = std::fs::read_to_string(path).ok()?;
    let d = doc::parse(&text);
    let summary = DocSummary {
        path: path.to_owned(),
        file: path.file_name()?.to_string_lossy().into_owned(),
        name: d.front.name.clone(),
        title: d.title.clone(),
        status: d.front.status.clone(),
        version: d.front.version.clone(),
        last_updated: d.front.last_updated.clone(),
        phase: d.current_phase().cloned(),
        has_resume: d.resume.is_some(),
    };
    Some(ParsedDoc { summary, targets: d.front.targets })
}

fn describe(dir: &Path, docs: &[DocSummary], manifest: &sources::Manifest) -> Option<String> {
    sources::claude_md(dir)
        .or_else(|| manifest.description.clone())
        .or_else(|| sources::readme(dir))
        .or_else(|| docs.iter().find_map(|d| d.title.clone()))
}

pub fn project(dir: &Path, docs: Vec<DocSummary>, claude_home: Option<&Path>) -> Project {
    let manifest = sources::manifest(dir);
    let (memories, sessions) = match claude_home {
        Some(home) => (claude_internals::memories(home, dir).len(), claude_internals::sessions(home, dir)),
        None => (0, Vec::new()),
    };
    Project {
        name: dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        path: dir.to_owned(),
        description: describe(dir, &docs, &manifest),
        has_claude_md: dir.join("CLAUDE.md").is_file(),
        git: sources::git(dir),
        manifest,
        memories,
        last_session: sessions.first().map(|s| s.modified),
        sessions: sessions.len(),
        docs,
    }
}

pub fn workspace(root: &Path, docs_folder: &Path, depth: usize, claude_home: Option<&Path>) -> Workspace {
    let dirs = scan::projects(root, docs_folder, depth);
    let parsed: Vec<ParsedDoc> = scan::docs(docs_folder).iter().filter_map(|p| parse_doc(p)).collect();
    let mut linked = vec![false; parsed.len()];
    let jobs: Vec<(PathBuf, Vec<DocSummary>)> = dirs
        .into_iter()
        .map(|dir| {
            let docs = parsed
                .iter()
                .enumerate()
                .filter(|(_, d)| scan::links(&d.summary.path, &d.targets, &dir))
                .map(|(i, d)| {
                    linked[i] = true;
                    d.summary.clone()
                })
                .collect();
            (dir, docs)
        })
        .collect();
    let projects = std::thread::scope(|scope| {
        let handles: Vec<_> = jobs.into_iter().map(|(dir, docs)| scope.spawn(move || project(&dir, docs, claude_home))).collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    let other_docs = parsed.into_iter().zip(linked).filter(|(_, l)| !l).map(|(d, _)| d.summary).collect();
    Workspace { projects, other_docs }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "reads C:\\projects; run with --ignored --nocapture"]
    fn real_workspace() {
        let started = std::time::Instant::now();
        let claude = claude_internals::home().map(|h| h.join(".claude"));
        let ws = workspace(Path::new(r"C:\projects"), Path::new(r"C:\projects\docs"), 1, claude.as_deref());
        println!("{} projects, {} other docs in {:?}", ws.projects.len(), ws.other_docs.len(), started.elapsed());
        for p in &ws.projects {
            let git = p.git.as_ref().map(|g| format!("{} +{} ~{}", g.branch.clone().unwrap_or_default(), g.ahead, g.uncommitted)).unwrap_or_default();
            let docs: Vec<String> = p
                .docs
                .iter()
                .map(|d| format!("{} v{} [{}]", d.file, d.version.clone().unwrap_or_default(), d.phase.as_ref().map(|ph| ph.title.clone()).unwrap_or_default()))
                .collect();
            println!("{:<24} {:<18} {:?} | {}", p.name, git, p.manifest.stack, docs.join("; "));
        }
        println!("other docs: {:?}", ws.other_docs.iter().map(|d| d.file.clone()).collect::<Vec<_>>());
        let handler = ws.projects.iter().find(|p| p.name == "handler").expect("handler project");
        assert!(handler.docs.iter().any(|d| d.file == "handler.md"));
        assert!(handler.git.as_ref().is_some_and(|g| g.branch.is_some()));
        let spec = std::fs::read_to_string(r"C:\projects\docs\specs\handler.md").unwrap();
        let d = doc::parse(&spec);
        assert!(d.resume.is_some());
        assert!(d.ids.iter().any(|i| i.id == "FR-13"));
        assert!(d.phases.len() >= 6);
    }
}

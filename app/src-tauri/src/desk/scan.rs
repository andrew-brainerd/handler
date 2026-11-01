use std::path::{Path, PathBuf};

const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", ".obsidian", "dist", "build"];

pub fn same_path(a: &Path, b: &Path) -> bool {
    norm(&a.to_string_lossy()) == norm(&b.to_string_lossy())
}

pub fn norm(path: &str) -> String {
    let p = path.replace('\\', "/");
    let p = p.trim_end_matches('/');
    if cfg!(windows) { p.to_lowercase() } else { p.to_owned() }
}

pub fn is_project(dir: &Path) -> bool {
    dir.join(".git").exists() || dir.join("CLAUDE.md").is_file()
}

pub fn projects(workspace: &Path, docs: &Path, depth: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk_projects(workspace, docs, depth.max(1), &mut found);
    found.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
    found
}

fn walk_projects(dir: &Path, docs: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !path.is_dir() || name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) || same_path(&path, docs) {
            continue;
        }
        if is_project(&path) {
            found.push(path);
        } else if depth > 1 {
            walk_projects(&path, docs, depth - 1, found);
        }
    }
}

pub fn docs(folder: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk_docs(folder, &mut found);
    found.sort();
    found
}

fn walk_docs(dir: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                walk_docs(&path, found);
            }
        } else if name.to_lowercase().ends_with(".md") && name.to_lowercase() != "readme.md" {
            found.push(path);
        }
    }
}

pub fn target_path(target: &str) -> String {
    let t = target.split(" (").next().unwrap_or(target).trim();
    let t = t.trim_matches('`');
    let cut = t.find(['*', '?']).unwrap_or(t.len());
    norm(&t[..cut])
}

pub fn links(doc: &Path, targets: &[String], project: &Path) -> bool {
    let root = norm(&project.to_string_lossy());
    let by_target = targets.iter().map(|t| target_path(t)).any(|t| !t.is_empty() && (t == root || t.starts_with(&format!("{root}/"))));
    if by_target {
        return true;
    }
    let stem = doc.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let name = project.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    !name.is_empty() && (stem == name || stem.starts_with(&format!("{name}-")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_paths_drop_globs_and_comments() {
        assert_eq!(target_path(r"C:\projects\tally\relay\** (Node relay)"), norm("C:/projects/tally/relay"));
        assert_eq!(target_path("`C:/projects/tally`"), norm("C:/projects/tally"));
    }

    #[test]
    fn docs_link_by_target_or_name() {
        let tally = Path::new(r"C:\projects\tally");
        let spec = Path::new(r"C:\projects\docs\specs\other.md");
        assert!(links(spec, &[r"C:\projects\tally\roku\**".into()], tally));
        assert!(!links(spec, &[r"C:\projects\tally-old\x".into()], tally));
        assert!(links(Path::new("tally.md"), &[], tally));
        assert!(links(Path::new("tally-context.md"), &[], tally));
        assert!(!links(Path::new("tallyho.md"), &[], tally));
    }
}

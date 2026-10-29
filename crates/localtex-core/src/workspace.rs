pub use crate::paths::safe_path;
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};
use walkdir::WalkDir;

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_TEXT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub version: u32,
    pub root: Option<String>,
    pub engine: Option<String>,
    #[serde(default)]
    pub shell_escape: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub editable: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Document {
    pub path: String,
    pub text: String,
    pub revision: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub directory: String,
    pub files: Vec<Entry>,
    pub config: ProjectConfig,
    pub roots: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub project: String,
    pub path: String,
    pub text: String,
    pub revision: String,
}

pub fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
pub fn editable(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "tex" | "bib" | "sty" | "cls" | "txt" | "md" | "bst" | "csv"
    )
}
pub fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Invalid file path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn read(root: &Path, name: &str) -> Result<Document> {
    let path = safe_path(root, name, true)?;
    if !editable(&path) {
        return Err("This file is not a supported text document.".into());
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_TEXT {
        return Err("Text files larger than 8 MB are not opened in the editor.".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let revision = hash(&bytes);
    let text = String::from_utf8(bytes)
        .map_err(|_| "This file is not UTF-8. Convert it to UTF-8 before editing.".to_string())?;
    Ok(Document {
        path: name.into(),
        text,
        revision,
    })
}
pub fn save(root: &Path, doc: &Document) -> Result<String> {
    let path = safe_path(root, &doc.path, true)?;
    let current = fs::read(&path).map_err(|e| e.to_string())?;
    if hash(&current) != doc.revision {
        return Err(
            "CONFLICT: This file changed on disk. Review the external version before saving."
                .into(),
        );
    }
    atomic_write(&path, doc.text.as_bytes())?;
    Ok(hash(doc.text.as_bytes()))
}
pub fn inspect(root: &Path) -> Result<Project> {
    let mut files = Vec::new();
    let mut roots = Vec::new();
    let entries = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || !matches!(
                    e.file_name().to_str().unwrap_or(""),
                    ".git" | ".localtex" | "node_modules" | "target"
                )
        });
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }
        if files.len() >= 20000 {
            return Err(
                "This folder contains more than 20,000 files. Open a narrower project folder."
                    .into(),
            );
        }
        let path = relative(root, entry.path());
        let size = entry.metadata().map_err(|e| e.to_string())?.len();
        if path.ends_with(".tex") && size <= MAX_TEXT {
            if let Ok(text) = fs::read_to_string(entry.path()) {
                if text
                    .lines()
                    .any(|l| l.trim_start().starts_with("\\documentclass"))
                {
                    roots.push(path.clone());
                }
            }
        }
        files.push(Entry {
            path,
            size,
            editable: editable(entry.path()),
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    roots.sort();
    let config_path = root.join(".localtex/project.json");
    let config = if config_path.exists() {
        serde_json::from_slice(&fs::read(config_path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Cannot read project settings: {e}"))?
    } else {
        ProjectConfig {
            version: 1,
            ..Default::default()
        }
    };
    let directory = root.to_string_lossy().into_owned();
    Ok(Project {
        id: hash(directory.as_bytes()),
        name: root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        directory,
        files,
        config,
        roots,
    })
}
pub fn validate_config(root: &Path, config: &ProjectConfig) -> Result<()> {
    if config.version != 1 {
        return Err("Unsupported project settings version.".into());
    }
    if let Some(name) = &config.root {
        safe_path(root, name, true)?;
        if !name.ends_with(".tex") {
            return Err("The root document must be a .tex file.".into());
        }
    }
    if let Some(engine) = &config.engine {
        if !["pdflatex", "xelatex", "lualatex"].contains(&engine.as_str()) {
            return Err("Unsupported LaTeX engine.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_paths_outside_project() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        for name in [
            "../secret.tex",
            "C:\\secret.tex",
            "a/../../secret.tex",
            "/etc/passwd",
            "a:stream",
        ] {
            assert!(safe_path(&root, name, false).is_err(), "{name}");
        }
    }
    #[test]
    fn save_is_conflict_checked_and_unicode_safe() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("গবেষণা.tex"), "first").unwrap();
        let mut doc = read(&root, "গবেষণা.tex").unwrap();
        doc.text = "second".into();
        save(&root, &doc).unwrap();
        assert_eq!(fs::read_to_string(root.join(&doc.path)).unwrap(), "second");
        assert!(save(&root, &doc).unwrap_err().starts_with("CONFLICT:"));
    }
    #[test]
    fn discovers_roots_and_ignores_build_outputs() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("main.tex"), "\\documentclass{article}").unwrap();
        fs::create_dir_all(temp.path().join(".localtex/build")).unwrap();
        fs::write(
            temp.path().join(".localtex/build/junk.tex"),
            "\\documentclass{article}",
        )
        .unwrap();
        let project = inspect(temp.path()).unwrap();
        assert_eq!(project.roots, vec!["main.tex"]);
        assert_eq!(project.files.len(), 1);
    }
}

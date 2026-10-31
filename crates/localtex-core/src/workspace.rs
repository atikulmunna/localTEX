use crate::encoding;
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
    /// Read the project's latexmkrc. Like shell escape, it needs local consent too.
    #[serde(default)]
    pub latexmkrc: bool,
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
    /// Shown to the user; saving follows the encoding of the file on disk.
    #[serde(default)]
    pub encoding: String,
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
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    if matches!(name.as_str(), "latexmkrc" | ".latexmkrc") {
        return true;
    }
    matches!(
        path.extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "tex"
            | "ltx"
            | "bib"
            | "sty"
            | "cls"
            | "clo"
            | "cfg"
            | "def"
            | "fd"
            | "dtx"
            | "ins"
            | "bst"
            | "bbx"
            | "cbx"
            | "lbx"
            | "dbx"
            | "ist"
            | "tikz"
            | "pgf"
            | "lua"
            | "txt"
            | "md"
            | "csv"
            | "json"
            | "yaml"
            | "yml"
    )
}
/// Files that other editors' builds leave beside the source (TeXstudio, VS Code,
/// TeXworks). They are hidden from the project so it stays readable.
const BUILD_OUTPUTS: &[&str] = &[
    ".aux",
    ".log",
    ".out",
    ".toc",
    ".lof",
    ".lot",
    ".loa",
    ".lol",
    ".fls",
    ".fdb_latexmk",
    ".synctex",
    ".synctex.gz",
    ".synctex(busy)",
    ".synctex.gz(busy)",
    ".bbl",
    ".blg",
    ".bcf",
    ".run.xml",
    ".idx",
    ".ilg",
    ".ind",
    ".glo",
    ".gls",
    ".glg",
    ".acn",
    ".acr",
    ".alg",
    ".nlo",
    ".nls",
    ".nav",
    ".snm",
    ".vrb",
    ".xdv",
    ".dvi",
    ".thm",
];
fn build_output(name: &str) -> bool {
    let name = name.to_lowercase();
    BUILD_OUTPUTS.iter().any(|suffix| name.ends_with(suffix))
}
const BOM: &str = "\u{feff}";
/// How a file on disk is laid out, so a save keeps the author's line endings and
/// byte-order mark instead of rewriting every line for other editors and git.
struct Layout {
    crlf: bool,
    bom: bool,
}
fn layout(bytes: &[u8]) -> Layout {
    let crlf = bytes.windows(2).filter(|pair| pair == b"\r\n").count();
    let lf = bytes.iter().filter(|&&byte| byte == b'\n').count();
    Layout {
        // Mixed files follow whichever ending most lines use.
        crlf: crlf * 2 > lf,
        bom: bytes.starts_with(BOM.as_bytes()),
    }
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
    let encoding = encoding::detect(&bytes);
    let text = encoding::decode(&bytes, encoding);
    // The editor works with "\n" and no byte-order mark; `save` restores the file's own layout.
    let text = text
        .strip_prefix(BOM)
        .unwrap_or(&text)
        .replace("\r\n", "\n");
    Ok(Document {
        path: name.into(),
        text,
        revision,
        encoding: encoding.name().into(),
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
    let layout = layout(&current);
    let body = doc.text.strip_prefix(BOM).unwrap_or(&doc.text);
    let mut text = if layout.crlf {
        body.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        body.to_string()
    };
    if layout.bom {
        text.insert_str(0, BOM);
    }
    let encoding = encoding::detect(&current);
    let bytes = encoding::encode(&text, encoding).map_err(|c| {
        format!(
            "{} is saved as {}, which can’t store “{c}”. Remove that character, or convert the file to UTF-8.",
            doc.path,
            encoding.name()
        )
    })?;
    atomic_write(&path, &bytes)?;
    Ok(hash(&bytes))
}
pub fn inspect(root: &Path) -> Result<Project> {
    let mut files = Vec::new();
    let mut roots = Vec::new();
    let entries = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_str().unwrap_or("");
            // Hidden folders (.git, .localtex, .vscode) and minted caches are not project source.
            let hidden_folder =
                e.file_type().is_dir() && (name.starts_with('.') || name.starts_with("_minted"));
            e.depth() == 0 || !(hidden_folder || matches!(name, "node_modules" | "target"))
        });
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file() || build_output(&entry.file_name().to_string_lossy()) {
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
            if let Ok(bytes) = fs::read(entry.path()) {
                let text = encoding::decode(&bytes, encoding::detect(&bytes));
                if text.lines().any(|l| {
                    l.trim_start_matches(BOM)
                        .trim_start()
                        .starts_with("\\documentclass")
                }) {
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
    fn saving_keeps_windows_line_endings_and_byte_order_mark() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let original = "\u{feff}\\documentclass{article}\r\n\\begin{document}\r\nHi\r\n";
        fs::write(root.join("main.tex"), original).unwrap();
        let mut doc = read(&root, "main.tex").unwrap();
        // The editor sees plain "\n" text without the invisible mark.
        assert_eq!(
            doc.text,
            "\\documentclass{article}\n\\begin{document}\nHi\n"
        );
        doc.text.push_str("More\n");
        let revision = save(&root, &doc).unwrap();
        let written = fs::read_to_string(root.join("main.tex")).unwrap();
        assert_eq!(written, format!("{original}More\r\n"));
        assert_eq!(revision, hash(written.as_bytes()));
        // An unchanged round trip writes identical bytes, so git sees no difference.
        let doc = read(&root, "main.tex").unwrap();
        save(&root, &doc).unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), written);
    }
    #[test]
    fn unix_files_stay_unix_and_mixed_files_follow_most_lines() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("unix.tex"), "a\nb\n").unwrap();
        let mut doc = read(&root, "unix.tex").unwrap();
        doc.text.push_str("c\n");
        save(&root, &doc).unwrap();
        assert_eq!(fs::read(root.join("unix.tex")).unwrap(), b"a\nb\nc\n");
        fs::write(root.join("mixed.tex"), "a\r\nb\r\nc\n").unwrap();
        let doc = read(&root, "mixed.tex").unwrap();
        save(&root, &doc).unwrap();
        assert_eq!(
            fs::read(root.join("mixed.tex")).unwrap(),
            b"a\r\nb\r\nc\r\n"
        );
    }
    #[test]
    fn projects_from_other_editors_open_cleanly() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        // Saved with a byte-order mark, as Notepad and some Windows editors do.
        fs::write(
            root.join("main.tex"),
            "\u{feff}\\documentclass{article}\r\n",
        )
        .unwrap();
        for leftover in [
            "main.aux",
            "main.log",
            "main.synctex.gz",
            "main.fdb_latexmk",
            "main.bbl",
        ] {
            fs::write(root.join(leftover), "").unwrap();
        }
        for folder in [".vscode", "_minted-main"] {
            fs::create_dir(root.join(folder)).unwrap();
            fs::write(root.join(folder).join("settings.json"), "{}").unwrap();
        }
        for source in [
            "latexmkrc",
            "style.cfg",
            "custom.bbx",
            "figure.tikz",
            "main.pdf",
        ] {
            fs::write(root.join(source), "").unwrap();
        }
        let project = inspect(root).unwrap();
        assert_eq!(project.roots, vec!["main.tex"]);
        let listed: Vec<(&str, bool)> = project
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.editable))
            .collect();
        assert_eq!(
            listed,
            [
                ("custom.bbx", true),
                ("figure.tikz", true),
                ("latexmkrc", true),
                ("main.pdf", false),
                ("main.tex", true),
                ("style.cfg", true),
            ]
        );
    }
    #[test]
    fn latin1_projects_open_and_save_in_their_own_encoding() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let original = b"\\documentclass{article}\r\n\\usepackage[latin1]{inputenc}\r\nCaf\xe9\r\n";
        fs::write(root.join("main.tex"), original).unwrap();
        assert_eq!(inspect(&root).unwrap().roots, vec!["main.tex"]);
        let mut doc = read(&root, "main.tex").unwrap();
        assert_eq!(doc.encoding, "Windows-1252");
        assert!(doc.text.ends_with("Café\n"));
        doc.text.push_str("Na\u{ef}ve\n");
        doc.revision = save(&root, &doc).unwrap();
        let mut expected = original.to_vec();
        expected.extend(b"Na\xefve\r\n");
        assert_eq!(fs::read(root.join("main.tex")).unwrap(), expected);
        doc.text.push_str("গবেষণা\n");
        let error = save(&root, &doc).unwrap_err();
        assert!(
            error.contains("Windows-1252") && error.contains('গ'),
            "{error}"
        );
        assert_eq!(fs::read(root.join("main.tex")).unwrap(), expected);
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

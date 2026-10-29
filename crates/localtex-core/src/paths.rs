use std::path::{Component, Path, PathBuf};

pub fn safe_path(root: &Path, name: &str, must_exist: bool) -> Result<PathBuf, String> {
    let rel = Path::new(name);
    if name.is_empty()
        || rel.is_absolute()
        || rel.components().any(|c| !matches!(c, Component::Normal(_)))
        || name.contains(':')
    {
        return Err("Use a relative path inside this project.".into());
    }
    let path = root.join(rel);
    let canonical = if must_exist {
        path.canonicalize()
    } else {
        path.parent().ok_or("Invalid file path")?.canonicalize()
    }
    .map_err(|e| e.to_string())?;
    if !canonical.starts_with(root) {
        return Err("This path leaves the project folder.".into());
    }
    if path.exists()
        && !path
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(root)
    {
        return Err("Links outside the project are not accessible.".into());
    }
    Ok(path)
}

/// External TeX tools expect ordinary Windows paths, not Rust's verbatim paths.
pub fn tool_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_absolute_paths_and_windows_streams() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        for name in [
            "",
            "..",
            "../secret.tex",
            "C:\\secret.tex",
            "a/../../secret.tex",
            "/etc/passwd",
            "file.tex:stream",
        ] {
            assert!(safe_path(&root, name, false).is_err(), "{name}");
        }
    }
    #[test]
    fn accepts_unicode_names_inside_the_project() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        assert_eq!(
            safe_path(&root, "গবেষণা paper.tex", false).unwrap(),
            root.join("গবেষণা paper.tex")
        );
    }
    #[test]
    fn removes_verbatim_prefix_for_external_tools() {
        assert_eq!(
            tool_path(Path::new(r"\\?\D:\My paper\main.tex")),
            r"D:\My paper\main.tex"
        );
        assert_eq!(
            tool_path(Path::new(r"\\?\UNC\server\paper\main.tex")),
            r"\\server\paper\main.tex"
        );
        assert_eq!(tool_path(Path::new("main.tex")), "main.tex");
    }
}

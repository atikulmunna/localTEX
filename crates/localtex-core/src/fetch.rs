//! Downloads the packages and classes a document loads before it is compiled, so the first
//! build after adding \usepackage{...} does not fail on a missing file. MiKTeX only: it
//! finds the package that provides a file and installs it with its dependencies.
use crate::{paths, process, workspace::Result};
use serde::Serialize;
use std::{thread, time::Duration};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    /// Files that were missing and are now installed, such as "algorithm2e.sty".
    pub installed: Vec<String>,
    /// Files MiKTeX could not provide: a typo, a project-only file, or no connection.
    pub failed: Vec<String>,
}

/// A package or class file name that is safe to write into a probe document.
pub fn valid_file(name: &str) -> bool {
    let Some(stem) = name
        .strip_suffix(".sty")
        .or_else(|| name.strip_suffix(".cls"))
    else {
        return false;
    };
    !stem.is_empty()
        && stem.len() <= 64
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@'))
}

/// A document that only loads `file`, so MiKTeX fetches it and what it needs.
fn probe(file: &str) -> String {
    let (stem, class) = match file.strip_suffix(".cls") {
        Some(stem) => (stem, true),
        None => (file.trim_end_matches(".sty"), false),
    };
    if class {
        format!("\\documentclass{{{stem}}}\n\\begin{{document}}\nx\n\\end{{document}}\n")
    } else {
        format!(
            "\\documentclass{{article}}\n\\usepackage{{{stem}}}\n\\begin{{document}}\nx\n\\end{{document}}\n"
        )
    }
}

/// Whether TeX can find `file`. MiKTeX's findtexmf only searches; unlike kpsewhich it
/// never opens an installation prompt.
fn installed(directory: &Option<String>, file: &str) -> bool {
    let mut find = process::command(process::executable(directory, "findtexmf"));
    process::apply_path(&mut find, directory);
    find.arg(file);
    matches!(process::output_timeout(find, Duration::from_secs(30)), Ok((true, path)) if !path.is_empty())
}

/// Files from `files` that TeX cannot find, checked in parallel.
pub fn missing(directory: &Option<String>, files: &[String]) -> Vec<String> {
    let checks: Vec<_> = files
        .iter()
        .filter(|file| valid_file(file))
        .map(|file| {
            let (directory, file) = (directory.clone(), file.clone());
            thread::spawn(move || (!installed(&directory, &file)).then_some(file))
        })
        .collect();
    checks
        .into_iter()
        .filter_map(|check| check.join().ok().flatten())
        .collect()
}

/// Installs the files from `files` that are missing, using the project's engine so that
/// engine-specific packages such as fontspec load.
pub fn fetch(directory: &Option<String>, engine: &str, files: &[String]) -> Result<Fetched> {
    if !process::ENGINES.contains(&engine) {
        return Err("Unsupported LaTeX engine.".into());
    }
    let mut result = Fetched::default();
    let missing = missing(directory, files);
    if missing.is_empty() {
        return Ok(result);
    }
    let temporary = tempfile::tempdir().map_err(|e| e.to_string())?;
    for file in missing {
        std::fs::write(temporary.path().join("probe.tex"), probe(&file))
            .map_err(|e| e.to_string())?;
        let mut compile = process::command(process::executable(directory, engine));
        process::apply_path(&mut compile, directory);
        compile
            .current_dir(paths::tool_path(temporary.path()))
            .args([
                "--enable-installer",
                "-interaction=nonstopmode",
                "-halt-on-error",
                "-no-shell-escape",
                "probe.tex",
            ]);
        // The probe may still fail afterwards (a package can need options or other
        // packages); what counts is whether the file is now installed.
        let _ = process::output_timeout(compile, Duration::from_secs(10 * 60));
        if installed(directory, &file) {
            result.installed.push(file);
        } else {
            result.failed.push(file);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_plain_package_and_class_names_reach_a_probe() {
        assert!(valid_file("algorithm2e.sty"));
        assert!(valid_file("IEEEtran.cls"));
        assert!(valid_file("pgf-pie.sty"));
        assert!(!valid_file("evil}\\input{secret}.sty"));
        assert!(!valid_file("../escape.sty"));
        assert!(!valid_file("main.tex"));
        assert!(!valid_file(".sty"));
        assert_eq!(
            probe("IEEEtran.cls"),
            "\\documentclass{IEEEtran}\n\\begin{document}\nx\n\\end{document}\n"
        );
        assert!(probe("algorithm2e.sty").contains("\\usepackage{algorithm2e}"));
    }
    #[test]
    fn installed_files_are_not_reported_missing() {
        // Uses the TeX installation on this machine when there is one.
        if !installed(&None, "article.cls") {
            return;
        }
        let files = [
            "article.cls".to_string(),
            "localtex-no-such-package.sty".to_string(),
        ];
        assert_eq!(missing(&None, &files), ["localtex-no-such-package.sty"]);
    }
    #[test]
    #[ignore = "Downloads algorithm2e from MiKTeX's servers"]
    fn a_missing_package_is_downloaded() {
        let fetched = fetch(&None, "pdflatex", &["algorithm2e.sty".to_string()]).unwrap();
        assert!(
            fetched.failed.is_empty() && installed(&None, "algorithm2e.sty"),
            "{fetched:?}"
        );
    }
}

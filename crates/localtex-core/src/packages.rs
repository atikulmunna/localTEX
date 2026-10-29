use crate::{process, workspace::Result};
use std::{collections::HashSet, process::Command, time::Duration};

// Fixed package IDs: no package names or commands are taken from project source.
pub const COMMON_PACKAGES: &[&str] = &[
    "geometry",
    "amsmath",
    "amsfonts",
    "graphics",
    "hyperref",
    "kvsetkeys",
    "xcolor",
    "latex-tools",
    "booktabs",
    "caption",
    "float",
    "enumitem",
    "microtype",
    "siunitx",
    "pgf",
    "pgfplots",
    "listings",
    "fancyhdr",
    "titlesec",
    "setspace",
    "natbib",
    "biblatex",
    "biber-windows-x64",
    "fontspec",
    "unicode-math",
    "lm",
    "cm-super",
];

// These are application-owned documents, never project source. During setup only,
// MiKTeX may resolve dependencies actually loaded by the common package families.
const COMMON_PROBE: &str = r"\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb,graphicx,xcolor,booktabs}
\usepackage{array,longtable,tabularx,caption,subcaption,float,enumitem}
\usepackage{microtype,siunitx,tikz,pgfplots,listings,fancyhdr,titlesec,setspace,natbib}
\usepackage[hidelinks]{hyperref}
\begin{document}
Common packages are ready. $E=mc^2$.
\begin{tabular}{ll}\toprule Name & Value\\\midrule Test & 1\\\bottomrule\end{tabular}
\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}
\end{document}";
const BIBLIOGRAPHY_PROBE: &str = r"\documentclass{article}
\usepackage{biblatex}
\usepackage[hidelinks]{hyperref}
\begin{document}Bibliography packages are ready.\end{document}";

fn verify_compilation(
    directory: &Option<String>,
    execute: &mut impl FnMut(Command, Duration, usize) -> Result<(bool, String)>,
) -> Result<()> {
    let temporary = tempfile::tempdir().map_err(|e| e.to_string())?;
    for (name, source) in [
        ("common", COMMON_PROBE),
        ("bibliography", BIBLIOGRAPHY_PROBE),
    ] {
        let filename = format!("{name}.tex");
        std::fs::write(temporary.path().join(&filename), source).map_err(|e| e.to_string())?;
        let mut command = process::command(process::executable(directory, "pdflatex"));
        process::apply_path(&mut command, directory);
        command
            .current_dir(crate::paths::tool_path(temporary.path()))
            .args([
                "--enable-installer",
                "--disable-write18",
                "--dont-parse-first-line",
                "--interaction=nonstopmode",
                "--halt-on-error",
                "--file-line-error",
                &filename,
            ]);
        let (success, output) = execute(command, Duration::from_secs(15 * 60), 128 * 1024)?;
        if !success || !temporary.path().join(format!("{name}.pdf")).is_file() {
            return Err(format!("Common-package verification failed. MiKTeX could not finish its dependencies. Check your connection/repository, then use Install / repair common packages in Settings.\n{output}"));
        }
    }
    Ok(())
}

fn missing_packages(list: &str) -> Vec<&'static str> {
    let installed: HashSet<&str> = list
        .lines()
        .filter_map(|line| {
            let (name, installed) = line.trim().split_once(',')?;
            matches!(installed.trim(), "1" | "true" | "True").then_some(name.trim())
        })
        .collect();
    COMMON_PACKAGES
        .iter()
        .copied()
        .filter(|name| !installed.contains(name))
        .collect()
}

pub fn prepare(directory: Option<String>) -> Result<String> {
    prepare_with(directory, &mut process::output_timeout_limit)
}

fn prepare_with(
    directory: Option<String>,
    execute: &mut impl FnMut(Command, Duration, usize) -> Result<(bool, String)>,
) -> Result<String> {
    let mut version = process::command(process::executable(&directory, "pdflatex"));
    process::apply_path(&mut version, &directory);
    version.arg("--version");
    let (ready, description) = execute(version, Duration::from_secs(15), 128 * 1024)?;
    if !ready {
        return Err(format!(
            "Finish LaTeX setup before installing common packages.\n{description}"
        ));
    }
    if !description.to_lowercase().contains("miktex") {
        return Ok("Automatic common-package setup is available for MiKTeX. For TeX Live, install the packages through TeX Live Manager if needed.".into());
    }
    let make_command = || {
        let mut cmd = process::command(process::executable(&directory, "miktex"));
        process::apply_path(&mut cmd, &directory);
        cmd
    };
    let mut list = make_command();
    list.args(["packages", "list", "--template", "{id},{isInstalled}\n"]);
    let (success, output) = execute(list, Duration::from_secs(30), 1024 * 1024)?;
    if !success {
        return Err(format!("Could not check common packages. Open MiKTeX Console and finish setup, then retry.\n{output}"));
    }
    let missing = missing_packages(&output);
    if !missing.is_empty() {
        let mut install = make_command();
        install.args(["packages", "install"]).args(&missing);
        let (success, output) = execute(install, Duration::from_secs(15 * 60), 128 * 1024)?;
        if !success {
            return Err(format!("Common-package installation failed. Check your connection and MiKTeX repository, then retry in Settings.\n{output}"));
        }
    }
    // Package metadata alone cannot establish that all runtime dependencies exist.
    // Even a fully installed top-level bundle must pass these controlled compiles.
    verify_compilation(&directory, execute)?;
    let mut verify = make_command();
    verify.args(["packages", "list", "--template", "{id},{isInstalled}\n"]);
    let (success, output) = execute(verify, Duration::from_secs(30), 1024 * 1024)?;
    if !success || !missing_packages(&output).is_empty() {
        return Err("Some common packages are still missing. Retry setup in Settings or use MiKTeX Console.".into());
    }
    Ok(format!(
        "Common packages passed compilation checks. Installed {} bundle packages and resolved dependencies as needed.",
        missing.len()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installed_packages_are_not_downloaded_again() {
        let list = COMMON_PACKAGES
            .iter()
            .map(|p| format!("{p},true\r\n"))
            .collect::<String>();
        assert!(missing_packages(&list).is_empty());
        assert!(
            missing_packages(&list.replace("geometry,true", "geometry,false"))
                .contains(&"geometry")
        );
    }
    #[test]
    fn numeric_flags_and_unrelated_output_are_handled() {
        let missing = missing_packages("log line\ngeometry,1\namsmath,0\nunknown,1\n");
        assert!(!missing.contains(&"geometry"));
        assert!(missing.contains(&"amsmath"));
        assert!(missing.contains(&"hyperref"));
    }

    #[test]
    fn installed_bundle_still_resolves_runtime_dependencies_before_ready() {
        let installed = COMMON_PACKAGES
            .iter()
            .map(|p| format!("{p},true\n"))
            .collect::<String>();
        let mut probes = Vec::new();
        let result = prepare_with(None, &mut |command, _, _| {
            let args = command
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            if args == ["--version"] {
                return Ok((true, "MiKTeX-pdfTeX".into()));
            }
            if args.first().is_some_and(|a| a == "packages") {
                assert_eq!(
                    args[1], "list",
                    "Already installed bundle should not be reinstalled"
                );
                return Ok((true, installed.clone()));
            }
            assert!(args.contains(&"--enable-installer".into()));
            assert!(args.contains(&"--disable-write18".into()));
            let source = std::path::Path::new(args.last().unwrap());
            let working = command.get_current_dir().unwrap();
            assert!(std::fs::read_to_string(working.join(source))
                .unwrap()
                .contains("\\usepackage[hidelinks]{hyperref}"));
            std::fs::write(working.join(source.with_extension("pdf")), b"test PDF").unwrap();
            probes.push(source.to_path_buf());
            Ok((true, String::new()))
        })
        .unwrap();
        assert_eq!(probes.len(), 2);
        assert!(result.contains("passed compilation checks"));
    }

    #[test]
    fn failed_dependency_download_is_not_reported_as_ready() {
        let installed = COMMON_PACKAGES
            .iter()
            .map(|p| format!("{p},true\n"))
            .collect::<String>();
        let error = prepare_with(None, &mut |command, _, _| {
            let args = command
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            if args == ["--version"] {
                return Ok((true, "MiKTeX-pdfTeX".into()));
            }
            if args.first().is_some_and(|a| a == "packages") {
                return Ok((true, installed.clone()));
            }
            Ok((false, "LaTeX Error: File `kvsetkeys.sty' not found.".into()))
        })
        .unwrap_err();
        assert!(error.contains("kvsetkeys.sty"));
        assert!(error.contains("Install / repair"));
    }
}

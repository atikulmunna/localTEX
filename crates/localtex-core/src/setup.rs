//! First-run LaTeX setup: find the toolchain, install the common MiKTeX packages,
//! then compile sample documents so MiKTeX can fetch the files those packages load.
use crate::{paths, process, workspace::Result};
use serde::Serialize;
use std::{
    collections::HashSet,
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

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

/// Stored with a finished setup. Bump it when the package list or samples change,
/// so existing installs run setup once more.
pub const SETUP_VERSION: u32 = 2;

// Application-owned documents, never project source. They load the common package
// families so MiKTeX resolves the dependencies its package metadata leaves out.
const SAMPLES: &[(&str, &str)] = &[
    (
        "common",
        r"\documentclass{article}
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
\end{document}",
    ),
    (
        "bibliography",
        r"\documentclass{article}
\usepackage{biblatex}
\usepackage[hidelinks]{hyperref}
\begin{document}Bibliography packages are ready.\end{document}",
    ),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    Tools,
    Packages,
    Verify,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepState {
    Running,
    Done,
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Event {
    Step {
        step: Step,
        state: StepState,
        text: String,
    },
    Progress {
        step: Step,
        done: usize,
        total: usize,
        text: String,
    },
    Line {
        text: String,
    },
}

/// Tells the interface which fix to offer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Problem {
    MissingTex,
    MissingLatexmk,
    MissingPerl,
    PackageManager,
    Download,
    Sample,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub step: Step,
    pub problem: Problem,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub distribution: String,
    pub miktex: bool,
    pub installed: Vec<String>,
}

/// Runs one external command, reporting its output lines; returns (success, output tail).
pub type Exec<'a> =
    dyn FnMut(Command, Duration, &mut dyn FnMut(&str)) -> Result<(bool, String)> + 'a;

pub fn run(
    directory: &Option<String>,
    cancelled: &AtomicBool,
    report: &mut dyn FnMut(Event),
) -> std::result::Result<Outcome, Failure> {
    run_with(
        directory,
        &mut |command, timeout, on_line| {
            process::output_streaming(command, timeout, 64 * 1024, cancelled, on_line)
        },
        cancelled,
        report,
    )
}

fn fail(step: Step, problem: Problem, text: impl Into<String>) -> Failure {
    Failure {
        step,
        problem,
        text: text.into(),
    }
}

fn stopped(step: Step) -> Failure {
    fail(step, Problem::Cancelled, "Setup stopped.")
}

fn tail(text: &str, limit: usize) -> &str {
    let start = text.len().saturating_sub(limit);
    let start = (start..text.len())
        .find(|&i| text.is_char_boundary(i))
        .unwrap_or(text.len());
    text[start..].trim()
}

/// "MiKTeX-pdfTeX 4.27 (MiKTeX 26.5)" becomes "MiKTeX 26.5".
fn distribution_name(version: &str) -> String {
    let first = version.lines().next().unwrap_or_default();
    first
        .split('(')
        .skip(1)
        .filter_map(|part| part.split(')').next())
        .find(|name| name.contains("MiKTeX") || name.contains("TeX Live"))
        .map(|name| name.trim().to_string())
        .unwrap_or_else(|| {
            if first.to_lowercase().contains("miktex") {
                "MiKTeX".into()
            } else {
                "your LaTeX distribution".into()
            }
        })
}

/// The file TeX reports as missing, for example "kvsetkeys.sty".
pub fn missing_file(output: &str) -> Option<&str> {
    ["File `", "can't find file `"].iter().find_map(|marker| {
        let start = output.rfind(marker)? + marker.len();
        let end = output[start..].find('\'')?;
        Some(&output[start..start + end])
    })
}

/// The package or class a TeX output line has just opened, for progress text.
/// TeX wraps its log at 79 columns, so only paths that start at TeX's "(" file-open
/// marker count; a wrapped tail such as "ons/kvoptions.sty" would be a fragment.
fn loaded_file(line: &str) -> Option<&str> {
    line.split('(')
        .skip(1)
        .filter_map(|opened| opened.split(|c: char| c == ')' || c.is_whitespace()).next())
        .filter(|path| path.ends_with(".sty") || path.ends_with(".cls"))
        .map(|path| path.rsplit(['/', '\\']).next().unwrap_or(path))
        .filter(|name| name.len() > ".sty".len())
        .last()
}

fn run_with(
    directory: &Option<String>,
    exec: &mut Exec,
    cancelled: &AtomicBool,
    report: &mut dyn FnMut(Event),
) -> std::result::Result<Outcome, Failure> {
    let tool = |name: &str| {
        let mut cmd = process::command(process::executable(directory, name));
        process::apply_path(&mut cmd, directory);
        cmd
    };
    let is_stop = |error: &str| error == process::CANCELLED;

    // Step 1: the engine and latexmk must start before anything is downloaded.
    report(Event::Step {
        step: Step::Tools,
        state: StepState::Running,
        text: "Looking for LaTeX on this PC".into(),
    });
    let mut version = tool("pdflatex");
    version.arg("--version");
    let description = match exec(version, Duration::from_secs(90), &mut |_| {}) {
        Ok((true, text)) => text,
        Err(e) if is_stop(&e) => return Err(stopped(Step::Tools)),
        Ok((false, text)) => {
            return Err(fail(
                Step::Tools,
                Problem::MissingTex,
                format!("pdfLaTeX did not start. Finish installing MiKTeX, then try again.\n{}", tail(&text, 1500)),
            ))
        }
        Err(e) => {
            return Err(fail(
                Step::Tools,
                Problem::MissingTex,
                format!("LaTeX isn't installed, or localTEX can't find it. Install MiKTeX, then try again.\n{e}"),
            ))
        }
    };
    let miktex = description.to_lowercase().contains("miktex");
    let distribution = distribution_name(&description);
    let mut latexmk = tool("latexmk");
    latexmk.arg("--version");
    match exec(latexmk, Duration::from_secs(120), &mut |_| {}) {
        Ok((true, _)) => {}
        Err(e) if is_stop(&e) => return Err(stopped(Step::Tools)),
        other => {
            let detail = match other {
                Ok((_, text)) => text,
                Err(e) => e,
            };
            let mut perl = tool("perl");
            perl.arg("--version");
            return Err(match exec(perl, Duration::from_secs(30), &mut |_| {}) {
                Err(e) if is_stop(&e) => stopped(Step::Tools),
                Ok((true, _)) => fail(
                    Step::Tools,
                    Problem::MissingLatexmk,
                    format!("latexmk didn't start.\n{}", tail(&detail, 1500)),
                ),
                _ => fail(
                    Step::Tools,
                    Problem::MissingPerl,
                    "latexmk needs Perl, which isn't installed. Install Strawberry Perl, then try again.",
                ),
            });
        }
    }
    report(Event::Step {
        step: Step::Tools,
        state: StepState::Done,
        text: format!("Found {distribution} and latexmk"),
    });

    // Step 2: install the common packages that are missing, one at a time for honest progress.
    if cancelled.load(Ordering::SeqCst) {
        return Err(stopped(Step::Packages));
    }
    let mut installed = Vec::new();
    if !miktex {
        report(Event::Step {
            step: Step::Packages,
            state: StepState::Skipped,
            text: "TeX Live manages its own packages".into(),
        });
    } else {
        report(Event::Step {
            step: Step::Packages,
            state: StepState::Running,
            text: "Checking which common packages are installed".into(),
        });
        let wanted: HashSet<&str> = COMMON_PACKAGES.iter().copied().collect();
        let mut present = HashSet::new();
        let mut list = tool("miktex");
        list.args(["packages", "list", "--template", "{id},{isInstalled}\n"]);
        // The full listing is larger than the output tail, so read it line by line.
        let listed = exec(list, Duration::from_secs(120), &mut |line| {
            if let Some((id, flag)) = line.trim().split_once(',') {
                if matches!(flag.trim(), "1" | "true" | "True") && wanted.contains(id.trim()) {
                    present.insert(id.trim().to_string());
                }
            }
        });
        match listed {
            Ok((true, _)) => {}
            Err(e) if is_stop(&e) => return Err(stopped(Step::Packages)),
            Ok((false, text)) | Err(text) => {
                return Err(fail(
                    Step::Packages,
                    Problem::PackageManager,
                    format!("MiKTeX couldn't list its packages. Open MiKTeX Console once to finish its setup, then try again.\n{}", tail(&text, 1500)),
                ))
            }
        }
        let missing: Vec<&str> = COMMON_PACKAGES
            .iter()
            .copied()
            .filter(|name| !present.contains(*name))
            .collect();
        for (index, package) in missing.iter().enumerate() {
            report(Event::Progress {
                step: Step::Packages,
                done: index,
                total: missing.len(),
                text: format!("Installing {package}"),
            });
            let mut install = tool("miktex");
            install.args(["packages", "require", package]);
            match exec(install, Duration::from_secs(15 * 60), &mut |line| {
                report(Event::Line { text: line.into() })
            }) {
                Ok((true, _)) => installed.push(package.to_string()),
                Err(e) if is_stop(&e) => return Err(stopped(Step::Packages)),
                Ok((false, text)) | Err(text) => {
                    return Err(fail(
                        Step::Packages,
                        Problem::Download,
                        format!("Couldn't install {package}. Check your internet connection, then try again.\n{}", tail(&text, 1500)),
                    ))
                }
            }
        }
        report(Event::Step {
            step: Step::Packages,
            state: StepState::Done,
            text: match installed.len() {
                0 => format!(
                    "All {} common packages were already installed",
                    COMMON_PACKAGES.len()
                ),
                1 => "Installed 1 package".into(),
                n => format!("Installed {n} packages"),
            },
        });
    }

    // Step 3: package metadata can't prove every runtime file exists; a real compile can.
    if cancelled.load(Ordering::SeqCst) {
        return Err(stopped(Step::Verify));
    }
    report(Event::Step {
        step: Step::Verify,
        state: StepState::Running,
        text: "Compiling sample documents".into(),
    });
    let temporary =
        tempfile::tempdir().map_err(|e| fail(Step::Verify, Problem::Sample, e.to_string()))?;
    for (index, (name, source)) in SAMPLES.iter().enumerate() {
        let filename = format!("{name}.tex");
        std::fs::write(temporary.path().join(&filename), source)
            .map_err(|e| fail(Step::Verify, Problem::Sample, e.to_string()))?;
        report(Event::Progress {
            step: Step::Verify,
            done: index,
            total: SAMPLES.len(),
            text: format!("Compiling sample {} of {}", index + 1, SAMPLES.len()),
        });
        let mut compile = tool("pdflatex");
        compile.current_dir(paths::tool_path(temporary.path()));
        if miktex {
            compile.arg("--enable-installer");
        }
        compile.args([
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-file-line-error",
            "-no-shell-escape",
            &filename,
        ]);
        let mut last_progress: Option<Instant> = None;
        let result = exec(compile, Duration::from_secs(20 * 60), &mut |line| {
            report(Event::Line { text: line.into() });
            if let Some(file) = loaded_file(line) {
                if last_progress.is_none_or(|at| at.elapsed() > Duration::from_millis(150)) {
                    last_progress = Some(Instant::now());
                    report(Event::Progress {
                        step: Step::Verify,
                        done: index,
                        total: SAMPLES.len(),
                        text: format!("Loading {file}"),
                    });
                }
            }
        });
        match result {
            Ok((true, _)) if temporary.path().join(format!("{name}.pdf")).is_file() => {}
            Err(e) if is_stop(&e) => return Err(stopped(Step::Verify)),
            Ok((_, text)) | Err(text) => {
                return Err(fail(
                    Step::Verify,
                    if miktex { Problem::Download } else { Problem::Sample },
                    match (missing_file(&text), miktex) {
                        (Some(file), true) => format!("MiKTeX couldn't download {file}. Check your internet connection, then try again."),
                        (Some(file), false) => format!("{file} is missing. Install it with TeX Live Manager, then try again."),
                        (None, _) => format!("The sample document didn't compile.\n{}", tail(&text, 1500)),
                    },
                ))
            }
        }
    }
    report(Event::Progress {
        step: Step::Verify,
        done: SAMPLES.len(),
        total: SAMPLES.len(),
        text: "Sample documents compiled".into(),
    });
    report(Event::Step {
        step: Step::Verify,
        state: StepState::Done,
        text: "Sample documents compiled".into(),
    });
    Ok(Outcome {
        distribution,
        miktex,
        installed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    fn program(command: &Command) -> String {
        std::path::Path::new(command.get_program())
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    }

    /// A MiKTeX double: every common package is installed except `missing`.
    fn miktex<'a>(
        missing: &'static [&'static str],
        calls: &'a mut Vec<Vec<String>>,
    ) -> impl FnMut(Command, Duration, &mut dyn FnMut(&str)) -> Result<(bool, String)> + 'a {
        move |command, _, on_line| {
            let mut call = vec![program(&command)];
            call.extend(args(&command));
            calls.push(call.clone());
            match (call[0].as_str(), call.get(1).map(String::as_str)) {
                ("pdflatex", Some("--version")) => {
                    Ok((true, "MiKTeX-pdfTeX 4.27 (MiKTeX 26.5)".into()))
                }
                ("latexmk" | "perl", Some("--version")) => Ok((true, String::new())),
                ("miktex", _) if call[2] == "list" => {
                    for package in COMMON_PACKAGES {
                        on_line(&format!("{package},{}", !missing.contains(package)));
                    }
                    Ok((true, String::new()))
                }
                ("miktex", _) => Ok((true, String::new())),
                ("pdflatex", _) => {
                    let file = std::path::Path::new(call.last().unwrap());
                    let working = command.get_current_dir().unwrap();
                    on_line("(C:/MiKTeX/tex/latex/pgf/frontendlayer/tikz.sty");
                    std::fs::write(working.join(file.with_extension("pdf")), b"PDF").unwrap();
                    Ok((true, String::new()))
                }
                other => panic!("unexpected command {other:?}"),
            }
        }
    }

    #[test]
    fn installs_only_missing_packages_then_compiles_samples() {
        let mut calls = Vec::new();
        let mut events = Vec::new();
        let flag = AtomicBool::new(false);
        let outcome = run_with(
            &None,
            &mut miktex(&["kvsetkeys"], &mut calls),
            &flag,
            &mut |e| events.push(e),
        )
        .unwrap();
        assert_eq!(outcome.distribution, "MiKTeX 26.5");
        assert_eq!(outcome.installed, ["kvsetkeys"]);
        let installs: Vec<_> = calls
            .iter()
            .filter(|c| c.get(2).is_some_and(|a| a == "require"))
            .collect();
        assert_eq!(
            installs,
            [&vec![
                "miktex".to_string(),
                "packages".into(),
                "require".into(),
                "kvsetkeys".into()
            ]]
        );
        let samples: Vec<_> = calls
            .iter()
            .filter(|c| c[0] == "pdflatex" && c[1] != "--version")
            .collect();
        assert_eq!(samples.len(), 2);
        assert!(samples
            .iter()
            .all(|c| c.contains(&"--enable-installer".into())
                && c.contains(&"-no-shell-escape".into())));
        assert!(events.contains(&Event::Progress {
            step: Step::Packages,
            done: 0,
            total: 1,
            text: "Installing kvsetkeys".into()
        }));
        assert!(events
            .iter()
            .any(|e| matches!(e, Event::Progress { text, .. } if text == "Loading tikz.sty")));
        assert_eq!(
            events.last(),
            Some(&Event::Step {
                step: Step::Verify,
                state: StepState::Done,
                text: "Sample documents compiled".into()
            })
        );
    }

    #[test]
    fn installed_packages_are_not_downloaded_again() {
        let mut calls = Vec::new();
        let flag = AtomicBool::new(false);
        let outcome = run_with(&None, &mut miktex(&[], &mut calls), &flag, &mut |_| {}).unwrap();
        assert!(outcome.installed.is_empty());
        assert!(!calls
            .iter()
            .any(|c| c.get(2).is_some_and(|a| a == "require")));
    }

    #[test]
    fn missing_latex_is_reported_before_any_download() {
        let flag = AtomicBool::new(false);
        let mut calls = 0;
        let failure = run_with(
            &None,
            &mut |_, _, _| {
                calls += 1;
                Err("program not found".into())
            },
            &flag,
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(
            (failure.step, failure.problem),
            (Step::Tools, Problem::MissingTex)
        );
        assert_eq!(calls, 1);
    }

    #[test]
    fn latexmk_without_perl_asks_for_perl() {
        let flag = AtomicBool::new(false);
        let failure = run_with(
            &None,
            &mut |command, _, _| match program(&command).as_str() {
                "pdflatex" => Ok((true, "MiKTeX-pdfTeX 4.27 (MiKTeX 26.5)".into())),
                _ => Ok((false, "perl: not found".into())),
            },
            &flag,
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(failure.problem, Problem::MissingPerl);
    }

    #[test]
    fn a_dependency_that_cannot_download_is_named() {
        let flag = AtomicBool::new(false);
        let failure = run_with(
            &None,
            &mut |command, _, _| {
                let call = args(&command);
                match (program(&command).as_str(), call[0].as_str()) {
                    ("pdflatex", "--version") => {
                        Ok((true, "MiKTeX-pdfTeX 4.27 (MiKTeX 26.5)".into()))
                    }
                    ("pdflatex", _) => Ok((
                        false,
                        "! LaTeX Error: File `kvsetkeys.sty' not found.".into(),
                    )),
                    _ => Ok((true, String::new())),
                }
            },
            &flag,
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(
            (failure.step, failure.problem),
            (Step::Verify, Problem::Download)
        );
        assert!(failure.text.contains("kvsetkeys.sty"));
    }

    #[test]
    fn tex_live_skips_miktex_package_steps() {
        let flag = AtomicBool::new(false);
        let mut calls = Vec::new();
        let mut events = Vec::new();
        let outcome = run_with(
            &None,
            &mut |command, _, _| {
                calls.push(args(&command));
                if args(&command) == ["--version"] {
                    return Ok((
                        true,
                        "pdfTeX 3.141592653-2.6-1.40.26 (TeX Live 2024)".into(),
                    ));
                }
                let working = command.get_current_dir().unwrap().to_path_buf();
                let file = std::path::PathBuf::from(args(&command).last().unwrap());
                std::fs::write(working.join(file.with_extension("pdf")), b"PDF").unwrap();
                Ok((true, String::new()))
            },
            &flag,
            &mut |e| events.push(e),
        )
        .unwrap();
        assert_eq!(outcome.distribution, "TeX Live 2024");
        assert!(!outcome.miktex);
        assert!(!calls
            .iter()
            .flatten()
            .any(|a| a == "--enable-installer" || a == "packages"));
        assert!(events.contains(&Event::Step {
            step: Step::Packages,
            state: StepState::Skipped,
            text: "TeX Live manages its own packages".into()
        }));
    }

    #[test]
    fn stopping_setup_is_not_reported_as_a_problem_to_fix() {
        let flag = AtomicBool::new(false);
        let failure = run_with(
            &None,
            &mut |_, _, _| Err(process::CANCELLED.into()),
            &flag,
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(failure.problem, Problem::Cancelled);
    }

    #[test]
    fn output_parsing_finds_package_files() {
        assert_eq!(
            missing_file("! LaTeX Error: File `kvsetkeys.sty' not found."),
            Some("kvsetkeys.sty")
        );
        assert_eq!(
            missing_file("! I can't find file `fancy.cls'."),
            Some("fancy.cls")
        );
        assert_eq!(missing_file("Output written on main.pdf"), None);
        assert_eq!(
            loaded_file("(C:\\MiKTeX\\tex\\latex\\geometry\\geometry.sty (C:/x/ifvtex.sty)"),
            Some("ifvtex.sty")
        );
        assert_eq!(loaded_file("Overfull \\hbox"), None);
        assert_eq!(
            loaded_file("ons/kvoptions.sty) (C:/MiKTeX/tex/latex/oberdiek/"),
            None
        );
        assert_eq!(loaded_file("(C:/MiKTeX/tex/latex/.sty"), None);
        assert_eq!(
            distribution_name("MiKTeX-pdfTeX 4.27 (MiKTeX 26.5)\n(c) Knuth"),
            "MiKTeX 26.5"
        );
    }
}

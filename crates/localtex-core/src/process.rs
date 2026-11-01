use crate::{process_job::ProcessJob, workspace::Result};
use serde::Serialize;
use std::{
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
pub const ENGINES: &[&str] = &["pdflatex", "xelatex", "lualatex"];
/// Error text returned when a supervised process was stopped on request.
pub const CANCELLED: &str = "Cancelled.";
/// MiKTeX's on-the-fly package installer. Other distributions have no equivalent flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Installer {
    Unsupported,
    Disabled,
    Enabled,
}
impl Installer {
    pub fn new(miktex: bool, allow_downloads: bool) -> Self {
        match (miktex, allow_downloads) {
            (false, _) => Installer::Unsupported,
            (true, false) => Installer::Disabled,
            (true, true) => Installer::Enabled,
        }
    }
}
/// How strongly the PDF is compressed. In documents with large images, recompressing
/// every image at the engines' strongest level dominates compile time, on every pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
    /// Light compression while editing: several times faster with large images, at the
    /// cost of a larger PDF.
    Preview,
    /// The engine's normal compression, for a PDF to share.
    Final,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: String,
    pub available: bool,
    pub detail: String,
}
pub fn command(executable: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.stdin(Stdio::null());
    cmd
}
pub fn executable(directory: &Option<String>, tool: &str) -> PathBuf {
    if let Some(dir) = directory.as_ref().filter(|d| !d.is_empty()) {
        let path = Path::new(dir).join(if cfg!(windows) {
            format!("{tool}.exe")
        } else {
            tool.into()
        });
        if ["perl", "biber"].contains(&tool) && !path.exists() {
            tool.into()
        } else {
            path
        }
    } else {
        tool.into()
    }
}
pub fn apply_path(cmd: &mut Command, directory: &Option<String>) {
    if let Some(dir) = directory.as_ref().filter(|d| !d.is_empty()) {
        let mut paths = vec![PathBuf::from(dir)];
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path));
        }
        if let Ok(path) = std::env::join_paths(paths) {
            cmd.env("PATH", path);
        }
    }
}
/// Starts the engine once to learn whether it belongs to MiKTeX. A cold MiKTeX start
/// can take several seconds, so callers should cache the answer.
pub fn is_miktex(directory: &Option<String>, engine: &str) -> Result<bool> {
    if !ENGINES.contains(&engine) {
        return Err("Unsupported LaTeX engine.".into());
    }
    let mut version = command(executable(directory, engine));
    apply_path(&mut version, directory);
    version.arg("--version");
    let (ready, description) = output_timeout(version, Duration::from_secs(60)).map_err(|e| {
        format!("{engine} could not start. Install MiKTeX, or choose its folder in Settings.\n{e}")
    })?;
    if !ready {
        return Err(format!(
            "{engine} is not ready. Finish your LaTeX installation, then try again.\n{description}"
        ));
    }
    Ok(description.to_lowercase().contains("miktex"))
}
#[allow(clippy::too_many_arguments)]
pub fn configure_latexmk(
    directory: &Option<String>,
    engine: &str,
    working_directory: &Path,
    root: &str,
    output: Option<&str>,
    shell_escape: bool,
    installer: Installer,
    rc_file: Option<&str>,
    quality: Quality,
) -> Result<Command> {
    if !ENGINES.contains(&engine) {
        return Err("Unsupported LaTeX engine.".into());
    }
    let mut cmd = command(executable(directory, "latexmk"));
    apply_path(&mut cmd, directory);
    cmd.current_dir(crate::paths::tool_path(working_directory))
        .arg("-norc");
    // A project rc file is Perl that latexmk runs, so it is read only for a project the
    // user trusted. The options after it take precedence over anything it sets.
    if let Some(rc) = rc_file {
        cmd.arg("-r").arg(format!("./{rc}"));
    }
    cmd.args([
        match engine {
            "xelatex" => "-xelatex",
            "lualatex" => "-lualatex",
            _ => "-pdf",
        },
        "-interaction=nonstopmode",
        // Keep going past recoverable errors, as Overleaf does: one stray character must
        // not cost the whole PDF, and the bibliography and references still get resolved.
        // latexmk still exits with an error, so the app reports the errors with the PDF.
        "-f",
        "-file-line-error",
        "-synctex=1",
        // Without the user's consent, LaTeX gets the distributions' default restricted mode:
        // only a fixed list of safe helpers, such as the converter that lets pdfLaTeX use
        // EPS figures (common in IEEE and Elsevier templates). Arbitrary commands stay off.
        if shell_escape {
            "-latexoption=-shell-escape"
        } else {
            "-latexoption=-shell-restricted"
        },
    ]);
    // MiKTeX would otherwise show its own installation dialog mid-build. Downloads happen
    // only when the user asked for them. The templates contain only the validated engine name.
    // TeX wraps its output at 79 columns, splitting long file paths and error messages
    // across lines. TeX Live reads the width from the environment; MiKTeX takes an
    // option, which its LuaTeX rejects (the app rejoins those lines instead).
    cmd.env("max_print_line", "10000");
    let wide = if engine == "lualatex" {
        ""
    } else {
        " --max-print-line=10000"
    };
    // Preview builds compress lightly. pdfTeX and LuaTeX take the level from code that
    // latexmk runs before the document (its %P placeholder); XeTeX leaves compression to
    // xdvipdfmx, whose command gets -z 1. The PDF's name and SyncTeX data don't change.
    let pretex = match (quality, engine) {
        (Quality::Preview, "pdflatex") => Some(r"\pdfcompresslevel=1"),
        (Quality::Preview, "lualatex") => Some(r"\pdfvariable compresslevel=1"),
        _ => None,
    };
    if quality == Quality::Preview && engine == "xelatex" {
        cmd.arg("-e")
            .arg("$xdvipdfmx = q/xdvipdfmx -z 1 -E -o %D %O %S/");
    }
    let source = if pretex.is_some() { "%P" } else { "%S" };
    match installer {
        Installer::Disabled => cmd.arg(format!(
            "-{engine}={engine}{wide} --disable-installer %O {source}"
        )),
        Installer::Enabled => cmd.arg(format!(
            "-{engine}={engine}{wide} --enable-installer %O {source}"
        )),
        Installer::Unsupported => &mut cmd,
    };
    if let Some(code) = pretex {
        // latexmk's own engine commands (TeX Live) switch to %P with -usepretex.
        cmd.arg(if installer == Installer::Unsupported {
            format!("-usepretex={code}")
        } else {
            format!("-pretex={code}")
        });
    }
    if let Some(output) = output {
        cmd.arg(format!("-outdir={output}"));
    }
    cmd.arg(format!("./{root}"));
    Ok(cmd)
}
pub fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = command("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}
pub fn output_timeout(cmd: Command, timeout: Duration) -> Result<(bool, String)> {
    output_timeout_limit(cmd, timeout, 128 * 1024)
}
pub fn output_timeout_limit(
    mut cmd: Command,
    timeout: Duration,
    limit: usize,
) -> Result<(bool, String)> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let job = ProcessJob::attach(&child).map_err(|e| {
        kill_tree(&mut child);
        e.to_string()
    })?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let a = thread::spawn(move || drain(stdout, limit));
    let b = thread::spawn(move || drain(stderr, limit));
    let start = Instant::now();
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) => (),
            Err(e) => return Err(e.to_string()),
        }
        if start.elapsed() > timeout {
            job.terminate();
            kill_tree(&mut child);
            return Err("Timed out. Finish your LaTeX installation, then check again.".into());
        }
        thread::sleep(Duration::from_millis(40));
    };
    job.terminate();
    let mut bytes = a.join().unwrap_or_default();
    bytes.extend(b.join().unwrap_or_default());
    Ok((success, String::from_utf8_lossy(&bytes).trim().to_string()))
}
/// Like `output_timeout_limit`, but reports each output line as it arrives, keeps the
/// last `limit` bytes (where errors appear), and stops the process tree once `cancelled` is set.
pub fn output_streaming(
    mut cmd: Command,
    timeout: Duration,
    limit: usize,
    cancelled: &AtomicBool,
    on_line: &mut dyn FnMut(&str),
) -> Result<(bool, String)> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let job = ProcessJob::attach(&child).map_err(|e| {
        kill_tree(&mut child);
        e.to_string()
    })?;
    let (sender, receiver) = mpsc::channel::<String>();
    let pipes: [Option<Box<dyn Read + Send>>; 2] = [
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    ];
    let readers: Vec<_> = pipes
        .into_iter()
        .flatten()
        .map(|pipe| {
            let sender = sender.clone();
            thread::spawn(move || {
                for line in BufReader::new(pipe).split(b'\n') {
                    let Ok(bytes) = line else { break };
                    let text = String::from_utf8_lossy(&bytes).trim_end().to_string();
                    if sender.send(text).is_err() {
                        break;
                    }
                }
            })
        })
        .collect();
    drop(sender);
    let mut output = String::new();
    let mut record = |line: String, output: &mut String| {
        on_line(&line);
        output.push_str(&line);
        output.push('\n');
        if output.len() > limit {
            let cut = (output.len() - limit..output.len())
                .find(|&i| output.is_char_boundary(i))
                .unwrap_or(output.len());
            output.drain(..cut);
        }
    };
    let start = Instant::now();
    let stop = |job: &ProcessJob, child: &mut Child| {
        job.terminate();
        kill_tree(child);
    };
    let success = loop {
        if cancelled.load(Ordering::SeqCst) {
            stop(&job, &mut child);
            return Err(CANCELLED.into());
        }
        if start.elapsed() > timeout {
            stop(&job, &mut child);
            return Err(
                "Timed out. Check your internet connection and LaTeX installation, then try again."
                    .into(),
            );
        }
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) => (),
            Err(e) => return Err(e.to_string()),
        }
        if let Ok(line) = receiver.recv_timeout(Duration::from_millis(40)) {
            record(line, &mut output);
        }
    };
    // Descendants can keep the pipes open after the main process exits.
    job.terminate();
    for reader in readers {
        let _ = reader.join();
    }
    for line in receiver.try_iter() {
        record(line, &mut output);
    }
    Ok((success, output.trim().to_string()))
}
fn drain(mut reader: impl Read, limit: usize) -> Vec<u8> {
    let mut result = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let remaining = limit.saturating_sub(result.len());
                result.extend_from_slice(&buffer[..n.min(remaining)]);
            }
        }
    }
    result
}
/// Where tools are looked for: the PATH this process started with, then the PATH Windows
/// has on record now, then the usual MiKTeX, TeX Live and Strawberry Perl folders. An app
/// started from an environment that predates a LaTeX or Perl installation still finds it.
pub fn tool_search_path() -> Option<std::ffi::OsString> {
    let mut folders: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let same = |a: &Path, b: &Path| {
        let plain = |p: &Path| {
            p.to_string_lossy()
                .trim_end_matches(['\\', '/'])
                .to_lowercase()
        };
        plain(a) == plain(b)
    };
    let registered = registered_path()
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>());
    for folder in registered.chain(usual_tool_folders()) {
        if folder.is_dir() && !folders.iter().any(|known| same(known, &folder)) {
            folders.push(folder);
        }
    }
    std::env::join_paths(folders).ok()
}
fn usual_tool_folders() -> Vec<PathBuf> {
    let variable = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let mut folders = Vec::new();
    if let Some(local) = variable("LOCALAPPDATA") {
        folders.push(local.join(r"Programs\MiKTeX\miktex\bin\x64"));
    }
    for programs in [variable("ProgramFiles"), variable("ProgramFiles(x86)")]
        .into_iter()
        .flatten()
    {
        folders.push(programs.join(r"MiKTeX\miktex\bin\x64"));
        folders.push(programs.join(r"MiKTeX\miktex\bin"));
    }
    // TeX Live installs into C:\texlive\<year>; the newest year comes first.
    let mut years: Vec<PathBuf> = std::fs::read_dir(r"C:\texlive")
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.len() == 4 && name.chars().all(|c| c.is_ascii_digit()))
        })
        .collect();
    years.sort();
    for year in years.iter().rev() {
        for architecture in ["windows", "win64", "win32"] {
            folders.push(year.join("bin").join(architecture));
        }
    }
    folders.push(PathBuf::from(r"C:\Strawberry\perl\bin"));
    folders
}
/// The machine and user PATH values as stored now, with %VARIABLES% expanded.
#[cfg(windows)]
fn registered_path() -> Vec<std::ffi::OsString> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::System::{
        Environment::ExpandEnvironmentStringsW,
        Registry::{
            RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_NOEXPAND, RRF_RT_ANY,
        },
    };
    let wide = |text: &str| -> Vec<u16> {
        std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(Some(0))
            .collect()
    };
    let read = |root: HKEY, key: &str| -> Option<std::ffi::OsString> {
        let (key, name) = (wide(key), wide("Path"));
        let flags = RRF_RT_ANY | RRF_NOEXPAND;
        let mut size = 0u32;
        unsafe {
            let none = std::ptr::null_mut();
            // First call: the size only.
            if RegGetValueW(
                root,
                key.as_ptr(),
                name.as_ptr(),
                flags,
                none,
                std::ptr::null_mut(),
                &mut size,
            ) != 0
            {
                return None;
            }
            let mut raw = vec![0u16; size as usize / 2 + 1];
            if RegGetValueW(
                root,
                key.as_ptr(),
                name.as_ptr(),
                flags,
                none,
                raw.as_mut_ptr().cast(),
                &mut size,
            ) != 0
            {
                return None;
            }
            let needed = ExpandEnvironmentStringsW(raw.as_ptr(), std::ptr::null_mut(), 0);
            if needed == 0 {
                return None;
            }
            let mut expanded = vec![0u16; needed as usize];
            let written = ExpandEnvironmentStringsW(raw.as_ptr(), expanded.as_mut_ptr(), needed);
            if written == 0 || written > needed {
                return None;
            }
            Some(std::ffi::OsString::from_wide(
                &expanded[..written as usize - 1],
            ))
        }
    };
    [
        read(
            HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
        read(HKEY_CURRENT_USER, "Environment"),
    ]
    .into_iter()
    .flatten()
    .collect()
}
#[cfg(not(windows))]
fn registered_path() -> Vec<std::ffi::OsString> {
    Vec::new()
}
const TOOLS: &[&str] = &[
    "pdflatex", "xelatex", "lualatex", "latexmk", "synctex", "bibtex", "biber", "perl",
];
fn check_tool(directory: &Option<String>, name: &str) -> ToolStatus {
    let mut cmd = command(executable(directory, name));
    apply_path(&mut cmd, directory);
    cmd.arg("--version");
    // MiKTeX's biber unpacks itself on its first run, which can take a minute or more.
    let limit = if name == "biber" { 180 } else { 30 };
    match output_timeout(cmd, Duration::from_secs(limit)) {
        Ok((success, text)) => ToolStatus {
            name: name.into(),
            available: success,
            detail: text.chars().take(1800).collect(),
        },
        Err(detail) => ToolStatus {
            name: name.into(),
            available: false,
            detail,
        },
    }
}
/// Checks every tool at once; a cold MiKTeX start would otherwise multiply the wait.
pub fn check_tools(directory: Option<String>) -> Vec<ToolStatus> {
    let checks: Vec<_> = TOOLS
        .iter()
        .map(|&name| {
            let directory = directory.clone();
            thread::spawn(move || check_tool(&directory, name))
        })
        .collect();
    checks
        .into_iter()
        .zip(TOOLS)
        .map(|(check, &name)| {
            check.join().unwrap_or_else(|_| ToolStatus {
                name: name.into(),
                available: false,
                detail: "The check stopped unexpectedly.".into(),
            })
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn custom_tools_resolve_without_shell_interpolation() {
        let path = executable(&Some("C:/LaTeX tools/বাংলা".into()), "pdflatex");
        assert!(path.to_string_lossy().contains("LaTeX tools/বাংলা"));
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("pdflatex"));
    }
    #[test]
    fn missing_executable_is_an_actionable_error() {
        assert!(output_timeout(
            command("localtex-nonexistent-compiler"),
            Duration::from_secs(1)
        )
        .is_err());
    }
    #[test]
    fn output_is_bounded_without_stopping_pipe_drain() {
        let bytes = vec![b'a'; 300_000];
        assert_eq!(drain(bytes.as_slice(), 128 * 1024).len(), 128 * 1024);
    }
    #[cfg(windows)]
    #[test]
    fn process_output_and_timeout_are_observable() {
        let mut echo = command("powershell.exe");
        echo.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Write-Output 'localtex-process-ok'",
        ]);
        let (ok, text) = output_timeout(echo, Duration::from_secs(10)).unwrap();
        assert!(ok);
        assert!(text.contains("localtex-process-ok"));
        let mut slow = command("powershell.exe");
        slow.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        let start = Instant::now();
        assert!(output_timeout(slow, Duration::from_millis(150))
            .unwrap_err()
            .contains("Timed out"));
        assert!(start.elapsed() < Duration::from_secs(5));
    }
    #[cfg(windows)]
    #[test]
    fn streaming_reports_lines_keeps_the_tail_and_stops_on_request() {
        let mut echo = command("powershell.exe");
        echo.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Write-Output 'first line'; Write-Output 'second line'",
        ]);
        let mut lines = Vec::new();
        let running = AtomicBool::new(false);
        let (ok, text) = output_streaming(echo, Duration::from_secs(20), 12, &running, &mut |l| {
            lines.push(l.to_string())
        })
        .unwrap();
        assert!(ok);
        assert_eq!(lines, ["first line", "second line"]);
        assert_eq!(text, "second line");
        let mut slow = command("powershell.exe");
        slow.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        let stopped = AtomicBool::new(true);
        let start = Instant::now();
        assert_eq!(
            output_streaming(slow, Duration::from_secs(60), 1024, &stopped, &mut |_| {})
                .unwrap_err(),
            CANCELLED
        );
        assert!(start.elapsed() < Duration::from_secs(5));
    }
    #[cfg(windows)]
    #[test]
    fn tools_installed_after_an_old_environment_are_still_found() {
        let inherited: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        let search: Vec<PathBuf> = std::env::split_paths(&tool_search_path().unwrap()).collect();
        // The inherited order is kept; additions only follow it.
        assert_eq!(&search[..inherited.len()], &inherited[..]);
        let miktex = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap())
            .join(r"Programs\MiKTeX\miktex\bin\x64");
        let plain = |p: &Path| p.to_string_lossy().trim_end_matches('\\').to_lowercase();
        if miktex.is_dir() {
            assert!(search.iter().any(|p| plain(p) == plain(&miktex)));
        }
        // Added folders never repeat one that is already there.
        for (i, added) in search.iter().enumerate().skip(inherited.len()) {
            assert!(
                !search[..i].iter().any(|p| plain(p) == plain(added)),
                "{added:?}"
            );
        }
        assert!(
            !registered_path().is_empty(),
            "Windows keeps a PATH in the registry"
        );
    }
    #[test]
    fn installer_flag_follows_distribution_and_consent() {
        assert_eq!(Installer::new(false, true), Installer::Unsupported);
        assert_eq!(Installer::new(true, false), Installer::Disabled);
        assert_eq!(Installer::new(true, true), Installer::Enabled);
        let args = |engine, installer, rc, quality| -> Vec<String> {
            configure_latexmk(
                &None,
                engine,
                Path::new("."),
                "main.tex",
                None,
                false,
                installer,
                rc,
                quality,
            )
            .unwrap()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
        };
        let has = |args: &[String], arg: &str| args.iter().any(|a| a == arg);
        let pdf = args(
            "pdflatex",
            Installer::Enabled,
            Some("latexmkrc"),
            Quality::Final,
        );
        assert!(has(
            &pdf,
            "-pdflatex=pdflatex --max-print-line=10000 --enable-installer %O %S"
        ));
        // Only the trusted project rc is read, and localTEX's options come after it.
        assert_eq!(pdf[..4], ["-norc", "-r", "./latexmkrc", "-pdf"]);
        // Errors don't stop the build.
        assert!(has(&pdf, "-f") && !has(&pdf, "-halt-on-error"));
        // Restricted mode (EPS conversion and similar safe helpers) unless shell escape is trusted.
        assert!(has(&pdf, "-latexoption=-shell-restricted"));
        // A final build compresses normally; no code runs before the document.
        assert!(!pdf.iter().any(|a| a.contains("pretex") || a == "-e"));
        // MiKTeX's LuaTeX gets no width option it would reject.
        let lua = args("lualatex", Installer::Disabled, None, Quality::Final);
        assert!(has(&lua, "-lualatex=lualatex --disable-installer %O %S"));

        // Previews compress lightly, each engine in its own way.
        let pdf = args("pdflatex", Installer::Disabled, None, Quality::Preview);
        assert!(has(
            &pdf,
            "-pdflatex=pdflatex --max-print-line=10000 --disable-installer %O %P"
        ));
        assert!(has(&pdf, r"-pretex=\pdfcompresslevel=1"));
        let lua = args("lualatex", Installer::Enabled, None, Quality::Preview);
        assert!(has(&lua, "-lualatex=lualatex --enable-installer %O %P"));
        assert!(has(&lua, r"-pretex=\pdfvariable compresslevel=1"));
        let xe = args("xelatex", Installer::Enabled, None, Quality::Preview);
        assert!(has(&xe, "$xdvipdfmx = q/xdvipdfmx -z 1 -E -o %D %O %S/"));
        assert!(has(
            &xe,
            "-xelatex=xelatex --max-print-line=10000 --enable-installer %O %S"
        ));
        // TeX Live keeps latexmk's own engine commands, switched to the pre-document code.
        let live = args("pdflatex", Installer::Unsupported, None, Quality::Preview);
        assert!(has(&live, r"-usepretex=\pdfcompresslevel=1"));
        assert!(!live.iter().any(|a| a.starts_with("-pdflatex=")));
    }
}

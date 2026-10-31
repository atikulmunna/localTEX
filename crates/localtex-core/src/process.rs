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
        "-halt-on-error",
        "-file-line-error",
        "-synctex=1",
        if shell_escape {
            "-latexoption=-shell-escape"
        } else {
            "-latexoption=-no-shell-escape"
        },
    ]);
    // MiKTeX would otherwise show its own installation dialog mid-build. Downloads happen
    // only when the user asked for them. The templates contain only the validated engine name.
    match installer {
        Installer::Disabled => cmd.arg(format!("-{engine}={engine} --disable-installer %O %S")),
        Installer::Enabled => cmd.arg(format!("-{engine}={engine} --enable-installer %O %S")),
        Installer::Unsupported => &mut cmd,
    };
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
const TOOLS: &[&str] = &[
    "pdflatex", "xelatex", "lualatex", "latexmk", "synctex", "bibtex", "biber", "perl",
];
fn check_tool(directory: &Option<String>, name: &str) -> ToolStatus {
    let mut cmd = command(executable(directory, name));
    apply_path(&mut cmd, directory);
    cmd.arg("--version");
    match output_timeout(cmd, Duration::from_secs(30)) {
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
    #[test]
    fn installer_flag_follows_distribution_and_consent() {
        assert_eq!(Installer::new(false, true), Installer::Unsupported);
        assert_eq!(Installer::new(true, false), Installer::Disabled);
        assert_eq!(Installer::new(true, true), Installer::Enabled);
        let command = configure_latexmk(
            &None,
            "pdflatex",
            Path::new("."),
            "main.tex",
            None,
            false,
            Installer::Enabled,
            Some("latexmkrc"),
        )
        .unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.contains(&"-pdflatex=pdflatex --enable-installer %O %S".into()));
        // Only the trusted project rc is read, and localTEX's options come after it.
        assert_eq!(args[..4], ["-norc", "-r", "./latexmkrc", "-pdf"]);
    }
}

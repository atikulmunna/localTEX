use crate::{process_job::ProcessJob, workspace::Result};
use serde::Serialize;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
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
pub fn configure_latexmk(
    directory: &Option<String>,
    engine: &str,
    working_directory: &Path,
    root: &str,
    output: Option<&str>,
    shell_escape: bool,
) -> Result<Command> {
    if !["pdflatex", "xelatex", "lualatex"].contains(&engine) {
        return Err("Unsupported LaTeX engine.".into());
    }
    let mut version = command(executable(directory, engine));
    apply_path(&mut version, directory);
    version.arg("--version");
    let (ready, description) = output_timeout(version, Duration::from_secs(8))?;
    if !ready {
        return Err(format!(
            "{engine} is not ready. Finish your LaTeX installation in Settings.\n{description}"
        ));
    }
    let miktex = description.to_lowercase().contains("miktex");
    let mut cmd = command(executable(directory, "latexmk"));
    apply_path(&mut cmd, directory);
    cmd.current_dir(crate::paths::tool_path(working_directory))
        .args([
            "-norc",
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
    // Avoid hidden package downloads or interactive installation dialogs during writing.
    // These command templates contain only the validated engine name and constants.
    if miktex {
        cmd.arg(format!("-{engine}={engine} --disable-installer %O %S"));
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
pub fn check_tools(directory: Option<String>) -> Vec<ToolStatus> {
    [
        "pdflatex", "xelatex", "lualatex", "latexmk", "synctex", "bibtex", "biber", "perl",
    ]
    .into_iter()
    .map(|name| {
        let mut cmd = command(executable(&directory, name));
        apply_path(&mut cmd, &directory);
        cmd.arg("--version");
        match output_timeout(cmd, Duration::from_secs(8)) {
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
}

pub use localtex_core::process::{
    apply_path, check_tools, command, configure_latexmk, executable, is_miktex, kill_tree,
    output_timeout, Installer, Quality, ToolStatus,
};
use localtex_core::process_job::ProcessJob;
use serde::Serialize;
use std::{
    io::{BufRead, BufReader, Read},
    process::Child,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter};
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildEvent {
    pub project_id: String,
    pub build_id: String,
    pub kind: String,
    pub text: String,
    pub success: bool,
}
pub struct ActiveBuild {
    pub id: String,
    pub project: String,
    pub child: Arc<Mutex<Child>>,
    pub cancelled: Arc<AtomicBool>,
    pub job: Arc<ProcessJob>,
}

pub fn emit(app: &AppHandle, project: &str, id: &str, kind: &str, text: &str, success: bool) {
    let _ = app.emit(
        "build-event",
        BuildEvent {
            project_id: project.into(),
            build_id: id.into(),
            kind: kind.into(),
            text: text.into(),
            success,
        },
    );
}
pub fn stream<R: Read + Send + 'static>(
    reader: R,
    app: AppHandle,
    project: String,
    id: String,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(reader).split(b'\n') {
            match line {
                Ok(bytes) => emit(
                    &app,
                    &project,
                    &id,
                    "output",
                    &String::from_utf8_lossy(&bytes[..bytes.len().min(16000)]),
                    false,
                ),
                Err(_) => break,
            }
        }
    })
}
pub fn finish_cancel(active: &ActiveBuild) {
    active.cancelled.store(true, Ordering::SeqCst);
    active.job.terminate();
    if let Ok(mut child) = active.child.lock() {
        kill_tree(&mut child);
    }
}

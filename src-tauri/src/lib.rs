mod compiler;
use localtex_core::{paths, process_job, templates, workspace};

use compiler::{ActiveBuild, ToolStatus};
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State};
use workspace::{Document, Draft, Project, ProjectConfig, Result};

#[derive(Default)]
struct AppState {
    project: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    build: Mutex<Option<ActiveBuild>>,
    last_pdf: Mutex<Option<(String, PathBuf)>>,
    io: Mutex<()>,
    package_setup: Arc<Mutex<()>>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    recent: Vec<String>,
    tool_directory: Option<String>,
}
fn root(state: &AppState, project_id: &str) -> Result<PathBuf> {
    let guard = state.project.lock().map_err(|e| e.to_string())?;
    let root = guard.as_ref().ok_or("Open a project first.")?;
    if workspace::hash(root.to_string_lossy().as_bytes()) != project_id {
        return Err("This project is no longer active.".into());
    }
    Ok(root.clone())
}
fn app_data(app: &tauri::AppHandle) -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(directory) = std::env::var_os("LOCALTEX_DEV_DATA_DIR") {
        let path = PathBuf::from(directory);
        if !path.is_absolute() {
            return Err("LOCALTEX_DEV_DATA_DIR must be absolute.".into());
        }
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        return Ok(path);
    }
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn shell_trusted(app: &tauri::AppHandle, id: &str) -> bool {
    app_data(app)
        .ok()
        .is_some_and(|path| path.join("trust").join(format!("{id}.json")).exists())
}
fn internal(root: &std::path::Path) -> Result<PathBuf> {
    let path = root.join(".localtex");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    if !path
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(root)
    {
        return Err("The .localtex folder must be inside the project.".into());
    }
    let build = path.join("build");
    fs::create_dir_all(&build).map_err(|e| e.to_string())?;
    if !build
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(root)
    {
        return Err("The build folder must be inside the project.".into());
    }
    if !path.join(".gitignore").exists() {
        workspace::atomic_write(&path.join(".gitignore"), b"build/\n")?;
    }
    Ok(path)
}
#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<Settings> {
    let path = app_data(&app)?.join("settings.json");
    if !path.exists() {
        return Ok(Settings::default());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<()> {
    workspace::atomic_write(
        &app_data(&app)?.join("settings.json"),
        &serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
    )
}
#[tauri::command]
async fn open_project(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    directory: String,
) -> Result<Project> {
    if state.build.lock().map_err(|e| e.to_string())?.is_some() {
        return Err("Cancel the current build before switching projects.".into());
    }
    let path = PathBuf::from(directory)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.is_dir() {
        return Err("Select a project folder.".into());
    }
    let inspect_path = path.clone();
    let mut project =
        tauri::async_runtime::spawn_blocking(move || workspace::inspect(&inspect_path))
            .await
            .map_err(|e| e.to_string())??;
    project.config.shell_escape &= shell_trusted(&app, &project.id);
    *state.project.lock().map_err(|e| e.to_string())? = Some(path.clone());
    *state.last_pdf.lock().map_err(|e| e.to_string())? = None;
    let id = project.id.clone();
    let watch_root = path.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return;
            }
            let paths: Vec<_> = event
                .paths
                .iter()
                .filter(|p| !p.starts_with(watch_root.join(".localtex")))
                .map(|p| workspace::relative(&watch_root, p))
                .collect();
            if !paths.is_empty() {
                let _ = app.emit(
                    "files-changed",
                    serde_json::json!({"projectId":id,"paths":paths}),
                );
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *state.watcher.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(project)
}
#[tauri::command]
async fn refresh_project(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Project> {
    let path = root(&state, &project_id)?;
    let mut project = tauri::async_runtime::spawn_blocking(move || workspace::inspect(&path))
        .await
        .map_err(|e| e.to_string())??;
    project.config.shell_escape &= shell_trusted(&app, &project.id);
    Ok(project)
}
#[tauri::command]
async fn read_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<Document> {
    let root = root(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || workspace::read(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn save_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    document: Document,
) -> Result<String> {
    let root = root(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _lock = state.io.lock().map_err(|e| e.to_string())?;
        workspace::save(&root, &document)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn create_file(state: State<'_, AppState>, project_id: String, path: String) -> Result<()> {
    let root = root(&state, &project_id)?;
    let path = workspace::safe_path(&root, &path, false)?;
    if !workspace::editable(&path) {
        return Err("Use a supported text extension, such as .tex or .bib.".into());
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn rename_file(
    state: State<'_, AppState>,
    project_id: String,
    from: String,
    to: String,
) -> Result<()> {
    let root = root(&state, &project_id)?;
    let from = workspace::safe_path(&root, &from, true)?;
    let to = workspace::safe_path(&root, &to, false)?;
    if to.exists() {
        return Err("A file with this name already exists.".into());
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}
#[tauri::command]
fn save_project_config(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    config: ProjectConfig,
) -> Result<()> {
    let root = root(&state, &project_id)?;
    workspace::validate_config(&root, &config)?;
    let trust = app_data(&app)?
        .join("trust")
        .join(format!("{project_id}.json"));
    if config.shell_escape {
        workspace::atomic_write(&trust, b"true")?;
    } else if trust.exists() {
        fs::remove_file(trust).map_err(|e| e.to_string())?;
    }
    workspace::atomic_write(
        &internal(&root)?.join("project.json"),
        &serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
    )
}
#[tauri::command]
fn create_project(parent: String, name: String, template: String) -> Result<String> {
    if name.trim().is_empty() || name.contains(['/', '\\', ':']) || name == "." || name == ".." {
        return Err("Choose a valid folder name.".into());
    }
    if !["article", "thesis"].contains(&template.as_str()) {
        return Err("Choose an article or thesis template.".into());
    }
    let parent = PathBuf::from(parent)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = parent.join(name.trim());
    fs::create_dir(&path).map_err(|e| e.to_string())?;
    workspace::atomic_write(
        &path.join("main.tex"),
        if template == "thesis" {
            templates::THESIS.as_bytes()
        } else {
            templates::ARTICLE.as_bytes()
        },
    )?;
    workspace::atomic_write(&path.join("references.bib"), templates::BIB.as_bytes())?;
    if template == "thesis" {
        workspace::atomic_write(&path.join("introduction.tex"),b"\\chapter{Introduction}\n\\label{ch:introduction}\nStart with a question worth exploring.\n")?;
    }
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
fn save_draft(app: tauri::AppHandle, draft: Draft) -> Result<()> {
    let key = workspace::hash(format!("{}:{}", draft.project, draft.path).as_bytes());
    workspace::atomic_write(
        &app_data(&app)?.join("recovery").join(format!("{key}.json")),
        &serde_json::to_vec(&draft).map_err(|e| e.to_string())?,
    )
}
#[tauri::command]
fn remove_draft(app: tauri::AppHandle, project: String, path: String) -> Result<()> {
    let key = workspace::hash(format!("{project}:{path}").as_bytes());
    let path = app_data(&app)?.join("recovery").join(format!("{key}.json"));
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
fn load_drafts(app: tauri::AppHandle, project: String) -> Result<Vec<Draft>> {
    let path = app_data(&app)?.join("recovery");
    let mut drafts = Vec::new();
    if path.exists() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())?.flatten() {
            if let Ok(bytes) = fs::read(entry.path()) {
                if let Ok(draft) = serde_json::from_slice::<Draft>(&bytes) {
                    if draft.project == project {
                        drafts.push(draft);
                    }
                }
            }
        }
    }
    Ok(drafts)
}
#[tauri::command]
async fn index_project(state: State<'_, AppState>, project_id: String) -> Result<Vec<Document>> {
    let root = root(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let project = workspace::inspect(&root)?; let mut docs = Vec::new(); let mut size = 0;
        for file in project.files.iter().filter(|f|f.editable && f.size <= workspace::MAX_TEXT) {
            size += file.size; if size > 32*1024*1024 { return Err("Project text exceeds the 32 MB search/index limit. Open a smaller project folder.".into()); }
            docs.push(workspace::read(&root,&file.path)?);
        } Ok(docs)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn prepare_packages(state: State<'_, AppState>, directory: Option<String>) -> Result<String> {
    let lock = state.package_setup.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|e| e.to_string())?;
        localtex_core::packages::prepare(directory)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn check_toolchain(directory: Option<String>) -> Result<Vec<ToolStatus>> {
    tauri::async_runtime::spawn_blocking(move || compiler::check_tools(directory))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn test_compilation(directory: Option<String>, engine: String) -> Result<String> {
    if !["pdflatex", "xelatex", "lualatex"].contains(&engine.as_str()) {
        return Err("Unsupported engine.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
        fs::write(
            temp.path().join("test.tex"),
            "\\documentclass{article}\n\\begin{document}localTEX is ready.\\end{document}",
        )
        .map_err(|e| e.to_string())?;
        let cmd =
            compiler::configure_latexmk(&directory, &engine, temp.path(), "test.tex", None, false)?;
        let (success, output) = compiler::output_timeout(cmd, Duration::from_secs(45))?;
        if success && temp.path().join("test.pdf").exists() {
            Ok("Compilation passed. Your local toolchain is ready.".into())
        } else {
            Err(output)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn start_build(
    app: tauri::AppHandle,
    project_id: String,
    build_id: String,
    document: String,
    engine: String,
    directory: Option<String>,
    force: bool,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        launch_build(
            app, project_id, build_id, document, engine, directory, force,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
fn launch_build(
    app: tauri::AppHandle,
    project_id: String,
    build_id: String,
    document: String,
    engine: String,
    directory: Option<String>,
    force: bool,
) -> Result<()> {
    let state = app.state::<AppState>();
    let root = root(&state, &project_id)?;
    if !["pdflatex", "xelatex", "lualatex"].contains(&engine.as_str()) {
        return Err("Unsupported engine.".into());
    }
    workspace::safe_path(&root, &document, true)?;
    if !document.ends_with(".tex") {
        return Err("Choose a .tex root document.".into());
    }
    let mut active = state.build.lock().map_err(|e| e.to_string())?;
    if active.is_some() {
        return Err("A build is already running.".into());
    }
    let config = workspace::inspect(&root)?.config;
    let build_dir = internal(&root)?.join("build");
    let mut cmd = compiler::configure_latexmk(
        &directory,
        &engine,
        &root,
        &document,
        Some(".localtex/build"),
        config.shell_escape && shell_trusted(&app, &project_id),
    )?;
    // -g reruns the engine without deleting auxiliary files or the last good PDF.
    // Manual retries must not reuse latexmk's cached failure after package repair.
    if force {
        cmd.arg("-g");
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start latexmk: {e}. Open Settings → LaTeX setup."))?;
    let job = Arc::new(process_job::ProcessJob::attach(&child).map_err(|e| {
        compiler::kill_tree(&mut child);
        format!("Could not supervise the compiler process: {e}")
    })?);
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let child = Arc::new(Mutex::new(child));
    let cancelled = Arc::new(AtomicBool::new(false));
    *active = Some(ActiveBuild {
        id: build_id.clone(),
        project: project_id.clone(),
        child: child.clone(),
        cancelled: cancelled.clone(),
        job: job.clone(),
    });
    drop(active);
    drop(state);
    std::thread::spawn(move || {
        compiler::emit(
            &app,
            &project_id,
            &build_id,
            "started",
            "Compiling on your machine",
            false,
        );
        let out = compiler::stream(stdout, app.clone(), project_id.clone(), build_id.clone());
        let err = compiler::stream(stderr, app.clone(), project_id.clone(), build_id.clone());
        let start = std::time::Instant::now();
        let mut timed_out = false;
        let success = loop {
            if start.elapsed() > Duration::from_secs(300) {
                timed_out = true;
                job.terminate();
                compiler::kill_tree(&mut child.lock().unwrap());
                break false;
            }
            match child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) => (),
                Err(_) => break false,
            }
            std::thread::sleep(Duration::from_millis(60));
        };
        job.terminate();
        let _ = out.join();
        let _ = err.join();
        let cancelled = cancelled.load(Ordering::SeqCst);
        let stem = std::path::Path::new(&document)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();
        let pdf = build_dir.join(format!("{stem}.pdf"));
        let mut success = success && !cancelled && !timed_out && pdf.exists();
        let state = app.state::<AppState>();
        if success {
            let snapshot = build_dir.join(format!(
                "preview-{}.pdf",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            ));
            if let Err(error) = fs::copy(&pdf, &snapshot) {
                success = false;
                compiler::emit(
                    &app,
                    &project_id,
                    &build_id,
                    "output",
                    &format!("Could not preserve the PDF preview: {error}"),
                    false,
                );
            } else {
                if let Some((_, old)) = state
                    .last_pdf
                    .lock()
                    .unwrap()
                    .replace((project_id.clone(), snapshot))
                {
                    let _ = fs::remove_file(old);
                }
            }
        }
        let mut active = state.build.lock().unwrap();
        if active.as_ref().is_some_and(|b| b.id == build_id) {
            *active = None;
        }
        drop(active);
        compiler::emit(
            &app,
            &project_id,
            &build_id,
            "finished",
            if cancelled {
                "Build cancelled"
            } else if timed_out {
                "Build timed out after five minutes"
            } else if success {
                "PDF is up to date"
            } else {
                "Build failed. Review the compiler output."
            },
            success,
        );
    });
    Ok(())
}
#[tauri::command]
async fn cancel_build(app: tauri::AppHandle, project_id: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if let Some(active) = state.build.lock().map_err(|e| e.to_string())?.as_ref() {
            if active.project == project_id {
                compiler::finish_cancel(active);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_pdf(state: State<'_, AppState>, project_id: String) -> Result<tauri::ipc::Response> {
    root(&state, &project_id)?;
    let path = state
        .last_pdf
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .filter(|(id, _)| id == &project_id)
        .map(|(_, p)| p.clone())
        .ok_or("Compile the project to see its PDF.")?;
    let bytes =
        tauri::async_runtime::spawn_blocking(move || fs::read(path).map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}
#[tauri::command]
fn export_pdf(state: State<'_, AppState>, project_id: String, destination: String) -> Result<()> {
    root(&state, &project_id)?;
    let pdf = state.last_pdf.lock().map_err(|e| e.to_string())?;
    let source = &pdf
        .as_ref()
        .filter(|(id, _)| id == &project_id)
        .ok_or("Compile a PDF first.")?
        .1;
    workspace::atomic_write(
        std::path::Path::new(&destination),
        &fs::read(source).map_err(|e| e.to_string())?,
    )
}
#[tauri::command]
async fn synctex(
    state: State<'_, AppState>,
    project_id: String,
    directory: Option<String>,
    document: String,
    source: Option<String>,
    line: Option<u32>,
    page: Option<u32>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String> {
    let root = root(&state, &project_id)?;
    workspace::safe_path(&root, &document, true)?;
    let stem = std::path::Path::new(&document)
        .file_stem()
        .ok_or("Invalid root")?
        .to_string_lossy();
    let pdf = root.join(".localtex/build").join(format!("{stem}.pdf"));
    let mut cmd = compiler::command(compiler::executable(&directory, "synctex"));
    compiler::apply_path(&mut cmd, &directory);
    cmd.current_dir(&root);
    if let Some(source) = source {
        let path = workspace::safe_path(&root, &source, true)?;
        cmd.arg("view")
            .arg("-i")
            .arg(format!(
                "{}:0:{}",
                line.unwrap_or(1),
                paths::tool_path(&path)
            ))
            .arg("-o")
            .arg(paths::tool_path(&pdf));
    } else {
        cmd.arg("edit").arg("-o").arg(format!(
            "{}:{}:{}:{}",
            page.unwrap_or(1),
            x.unwrap_or(0.0),
            y.unwrap_or(0.0),
            paths::tool_path(&pdf)
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (success, text) = compiler::output_timeout(cmd, Duration::from_secs(10))?;
        if success {
            Ok(text)
        } else {
            Err(text)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    let context = {
        let mut context = context;
        if std::env::var_os("LOCALTEX_DEV_DATA_DIR").is_some() {
            for window in &mut context.config_mut().app.windows {
                window.create = false;
            }
        }
        context
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|_app| {
            #[cfg(debug_assertions)]
            if std::env::var_os("LOCALTEX_DEV_DATA_DIR").is_some() {
                let app = _app;
                let path = app_data(app.handle()).map_err(std::io::Error::other)?;
                for config in &app.config().app.windows {
                    tauri::WebviewWindowBuilder::from_config(app, config)?
                        .data_directory(path.join("webview"))
                        .build()?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            open_project,
            refresh_project,
            read_file,
            save_file,
            create_file,
            rename_file,
            save_project_config,
            create_project,
            save_draft,
            remove_draft,
            load_drafts,
            index_project,
            check_toolchain,
            prepare_packages,
            test_compilation,
            start_build,
            cancel_build,
            read_pdf,
            export_pdf,
            synctex
        ])
        .build(context)
        .expect("Unable to start localTEX")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(active) = app.state::<AppState>().build.lock().unwrap().as_ref() {
                    compiler::finish_cancel(active);
                }
            }
        });
}

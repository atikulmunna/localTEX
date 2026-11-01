mod compiler;
mod spelling;
use localtex_core::{paths, process_job, setup, templates, workspace};

use compiler::{ActiveBuild, Installer, ToolStatus};
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
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
    /// Stop flag of the running LaTeX setup, if any.
    setup: Mutex<Option<Arc<AtomicBool>>>,
    /// Whether (tool folder, engine) belongs to MiKTeX, learned once per session.
    miktex: Mutex<HashMap<(String, String), bool>>,
}
/// Written when setup succeeds, so later launches skip it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupRecord {
    version: u32,
    tool_directory: Option<String>,
    distribution: String,
    miktex: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupStatus {
    complete: bool,
    running: bool,
    distribution: Option<String>,
    miktex: Option<bool>,
}
fn tool_folder(directory: &Option<String>) -> Option<String> {
    directory
        .as_ref()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
}
fn detect_miktex(app: &tauri::AppHandle, directory: &Option<String>, engine: &str) -> Result<bool> {
    let key = (
        tool_folder(directory).unwrap_or_default(),
        engine.to_string(),
    );
    let state = app.state::<AppState>();
    if let Some(&known) = state.miktex.lock().map_err(|e| e.to_string())?.get(&key) {
        return Ok(known);
    }
    let miktex = compiler::is_miktex(directory, engine)?;
    state
        .miktex
        .lock()
        .map_err(|e| e.to_string())?
        .insert(key, miktex);
    Ok(miktex)
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
fn rc_trusted(app: &tauri::AppHandle, id: &str) -> bool {
    app_data(app)
        .ok()
        .is_some_and(|path| path.join("trust").join(format!("{id}.latexmkrc")).exists())
}
/// The rc file latexmk would look for in the project folder, if there is one.
fn rc_file(root: &std::path::Path) -> Option<&'static str> {
    ["latexmkrc", ".latexmkrc"]
        .into_iter()
        .find(|name| root.join(name).is_file())
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
/// The folder TeX tools run in. latexmk runs on Perl, which only handles paths in the
/// ANSI code page, so a project path with other characters (Bangla, for example) is
/// reached through its 8.3 short name or, on drives without short names, an ASCII
/// junction in app data. Both lead to the same files.
fn tex_root(app: &tauri::AppHandle, project_id: &str, root: &std::path::Path) -> Result<PathBuf> {
    let real = paths::tool_path(root);
    if real.is_ascii() {
        return Ok(PathBuf::from(real));
    }
    if let Some(short) = paths::short_path(&real).filter(|s| s.is_ascii()) {
        return Ok(PathBuf::from(short));
    }
    let links = app_data(app)?.join("links");
    fs::create_dir_all(&links).map_err(|e| e.to_string())?;
    let links = paths::tool_path(&links);
    let links = if links.is_ascii() {
        links
    } else {
        paths::short_path(&links)
            .filter(|s| s.is_ascii())
            .ok_or("LaTeX tools can't read this project's folder name on this drive. Move the project to a folder with an English name.")?
    };
    let link = PathBuf::from(links).join(&project_id[..project_id.len().min(16)]);
    if link.canonicalize().ok() == Some(root.canonicalize().map_err(|e| e.to_string())?) {
        return Ok(link);
    }
    // A link left over from an earlier location is replaced; removing it keeps its target.
    if fs::symlink_metadata(&link).is_ok() {
        fs::remove_dir(&link).map_err(|e| e.to_string())?;
    }
    paths::junction(&link, root)
        .map_err(|e| format!("Could not prepare a path LaTeX tools can read: {e}"))?;
    Ok(link)
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
    project.config.latexmkrc &= rc_trusted(&app, &project.id);
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
    project.config.latexmkrc &= rc_trusted(&app, &project.id);
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
fn create_folder(state: State<'_, AppState>, project_id: String, path: String) -> Result<()> {
    workspace::create_folder(&root(&state, &project_id)?, &path)
}
#[tauri::command]
async fn delete_entry(state: State<'_, AppState>, project_id: String, path: String) -> Result<()> {
    let root = root(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || workspace::remove(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn import_files(
    state: State<'_, AppState>,
    project_id: String,
    folder: String,
    sources: Vec<String>,
) -> Result<Vec<String>> {
    let root = root(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || workspace::import(&root, &folder, &sources))
        .await
        .map_err(|e| e.to_string())?
}
/// Raw bytes of a project file such as an image, for previewing it.
#[tauri::command]
async fn read_binary(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<tauri::ipc::Response> {
    let path = workspace::safe_path(&root(&state, &project_id)?, &path, true)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 50 * 1024 * 1024 {
            return Err("Files larger than 50 MB are not previewed.".to_string());
        }
        fs::read(path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
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
    // Consent lives in app data, so copying a project's settings cannot grant it elsewhere.
    let trust = app_data(&app)?.join("trust");
    for (granted, file) in [
        (config.shell_escape, format!("{project_id}.json")),
        (config.latexmkrc, format!("{project_id}.latexmkrc")),
    ] {
        let path = trust.join(file);
        if granted {
            workspace::atomic_write(&path, b"true")?;
        } else if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
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
fn read_setup_record(app: &tauri::AppHandle) -> Option<SetupRecord> {
    let bytes = fs::read(app_data(app).ok()?.join("setup.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}
#[tauri::command]
fn setup_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    directory: Option<String>,
) -> Result<SetupStatus> {
    let running = state.setup.lock().map_err(|e| e.to_string())?.is_some();
    let record = read_setup_record(&app);
    let complete = record.as_ref().is_some_and(|r| {
        r.version == setup::SETUP_VERSION
            && tool_folder(&r.tool_directory) == tool_folder(&directory)
    });
    Ok(SetupStatus {
        complete,
        running,
        distribution: record.as_ref().map(|r| r.distribution.clone()),
        miktex: record.map(|r| r.miktex),
    })
}
fn emit_setup(app: &tauri::AppHandle, run_id: &str, payload: impl Serialize) {
    if let Ok(serde_json::Value::Object(mut message)) = serde_json::to_value(payload) {
        message.insert("runId".into(), run_id.into());
        let _ = app.emit("setup-event", message);
    }
}
#[tauri::command]
fn start_setup(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    directory: Option<String>,
) -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut running = state.setup.lock().map_err(|e| e.to_string())?;
        if running.is_some() {
            return Err("LaTeX setup is already running.".into());
        }
        *running = Some(stop.clone());
    }
    std::thread::spawn(move || {
        let directory = tool_folder(&directory);
        let result = setup::run(&directory, &stop, &mut |event| {
            emit_setup(&app, &run_id, event)
        });
        let state = app.state::<AppState>();
        if let Ok(outcome) = &result {
            let record = SetupRecord {
                version: setup::SETUP_VERSION,
                tool_directory: directory.clone(),
                distribution: outcome.distribution.clone(),
                miktex: outcome.miktex,
            };
            let saved = app_data(&app).and_then(|path| {
                workspace::atomic_write(
                    &path.join("setup.json"),
                    &serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?,
                )
            });
            if let Err(error) = saved {
                emit_setup(
                    &app,
                    &run_id,
                    serde_json::json!({"kind":"line","text":format!("Could not remember this setup: {error}")}),
                );
            }
        }
        if let Ok(mut running) = state.setup.lock() {
            *running = None;
        }
        emit_setup(
            &app,
            &run_id,
            match result {
                Ok(outcome) => {
                    serde_json::json!({"kind":"finished","success":true,"outcome":outcome})
                }
                Err(failure) => {
                    serde_json::json!({"kind":"finished","success":false,"failure":failure})
                }
            },
        );
    });
    Ok(())
}
#[tauri::command]
fn cancel_setup(state: State<'_, AppState>) -> Result<()> {
    if let Some(stop) = state.setup.lock().map_err(|e| e.to_string())?.as_ref() {
        stop.store(true, Ordering::SeqCst);
    }
    Ok(())
}
#[tauri::command]
async fn spelling_languages() -> Result<Vec<String>> {
    tauri::async_runtime::spawn_blocking(spelling::languages)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn check_spelling(language: String, text: String) -> Result<Vec<spelling::Misspelling>> {
    tauri::async_runtime::spawn_blocking(move || spelling::check(&language, &text))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn spelling_suggestions(language: String, word: String) -> Result<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || spelling::suggest(&language, &word))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn add_to_dictionary(language: String, word: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || spelling::add(&language, &word))
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
async fn test_compilation(
    app: tauri::AppHandle,
    directory: Option<String>,
    engine: String,
) -> Result<String> {
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
        let installer = Installer::new(detect_miktex(&app, &directory, &engine)?, false);
        let cmd = compiler::configure_latexmk(
            &directory,
            &engine,
            temp.path(),
            "test.tex",
            None,
            false,
            installer,
            None,
        )?;
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
    install: bool,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        launch_build(
            app, project_id, build_id, document, engine, directory, force, install,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[allow(clippy::too_many_arguments)]
fn launch_build(
    app: tauri::AppHandle,
    project_id: String,
    build_id: String,
    document: String,
    engine: String,
    directory: Option<String>,
    force: bool,
    install: bool,
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
    // Detect before taking the build lock: a cold MiKTeX start must not block Cancel.
    let installer = Installer::new(detect_miktex(&app, &directory, &engine)?, install);
    let tex = tex_root(&app, &project_id, &root)?;
    let mut active = state.build.lock().map_err(|e| e.to_string())?;
    if active.is_some() {
        return Err("A build is already running.".into());
    }
    let config = workspace::inspect(&root)?.config;
    let build_dir = internal(&root)?.join("build");
    let mut cmd = compiler::configure_latexmk(
        &directory,
        &engine,
        &tex,
        &document,
        Some(".localtex/build"),
        config.shell_escape && shell_trusted(&app, &project_id),
        installer,
        if config.latexmkrc && rc_trusted(&app, &project_id) {
            rc_file(&root)
        } else {
            None
        },
    )?;
    // -g reruns the engine without deleting auxiliary files or the last good PDF.
    // Retries and package installs must not reuse latexmk's cached failure.
    if force || install {
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
    app: tauri::AppHandle,
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
    // Query in the form the build recorded: the folder TeX ran in.
    let tex = paths::tool_path(&tex_root(&app, &project_id, &root)?);
    let real = paths::tool_path(&root);
    let pdf = format!(r"{tex}\.localtex\build\{stem}.pdf");
    let source = source
        .map(|source| {
            workspace::safe_path(&root, &source, true)?;
            Ok::<_, String>(source.replace('/', r"\"))
        })
        .transpose()?;
    let synctex = move |args: Vec<String>| {
        let mut cmd = compiler::command(compiler::executable(&directory, "synctex"));
        compiler::apply_path(&mut cmd, &directory);
        cmd.current_dir(&root).args(args);
        compiler::output_timeout(cmd, Duration::from_secs(10))
    };
    tauri::async_runtime::spawn_blocking(move || {
        let (success, text) = if let Some(source) = source {
            let view = |input: &str| {
                synctex(vec![
                    "view".into(),
                    "-i".into(),
                    format!("{}:0:{input}", line.unwrap_or(1)),
                    "-o".into(),
                    pdf.clone(),
                ])
            };
            // PDFs built before a folder change may have recorded the real or 8.3 form.
            let full = format!(r"{real}\{source}");
            let mut inputs = vec![format!(r"{tex}\{source}"), full.clone()];
            inputs.extend(paths::short_path(&full));
            inputs.dedup();
            let mut result = (false, String::new());
            for input in &inputs {
                result = view(input)?;
                if result.0 && result.1.contains("Page:") {
                    break;
                }
            }
            result
        } else {
            let (success, text) = synctex(vec![
                "edit".into(),
                "-o".into(),
                format!(
                    "{}:{}:{}:{pdf}",
                    page.unwrap_or(1),
                    x.unwrap_or(0.0),
                    y.unwrap_or(0.0)
                ),
            ])?;
            // Report the real path, so the interface can match it to a project file.
            let text = text
                .lines()
                .map(|line| match line.strip_prefix("Input:").map(str::trim) {
                    Some(input) => {
                        let mapped = input
                            .get(..tex.len())
                            .filter(|prefix| prefix.eq_ignore_ascii_case(&tex))
                            .map(|_| format!("{real}{}", &input[tex.len()..]))
                            .or_else(|| paths::long_path(input));
                        format!("Input:{}", mapped.as_deref().unwrap_or(input))
                    }
                    None => line.to_string(),
                })
                .collect::<Vec<_>>()
                .join("\n");
            (success, text)
        };
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
            create_folder,
            delete_entry,
            import_files,
            read_binary,
            spelling_languages,
            check_spelling,
            spelling_suggestions,
            add_to_dictionary,
            save_project_config,
            create_project,
            save_draft,
            remove_draft,
            load_drafts,
            index_project,
            check_toolchain,
            setup_status,
            start_setup,
            cancel_setup,
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

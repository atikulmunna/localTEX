import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorView } from "@codemirror/view";
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  FilePlus2,
  FileText,
  Files,
  FolderOpen,
  Hash,
  ListTree,
  Loader2,
  Maximize2,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Terminal,
  TriangleAlert,
  X,
} from "lucide-react";
import { api, desktop } from "./api";
import { Editor, clearEditorStates, forgetEditorState } from "./Editor";
import { PdfPreview } from "./PdfPreview";
import { Modal } from "./Modal";
import {
  diagnostics,
  outline,
  relativeSource,
  resolveBuild,
  searchProject,
  syncFields,
} from "./core";
import { demoDocuments, demoProject } from "./demo";
import { SerialQueue } from "./serial";
import type {
  BufferFile,
  BuildEvent,
  DocumentFile,
  Draft,
  Engine,
  Project,
  ProjectConfig,
  Settings,
  SyncPoint,
  ToolStatus,
} from "./types";

const readPreference = <T,>(key: string, fallback: T): T => {
  try {
    return (
      JSON.parse(localStorage.getItem(`localtex.${key}`) ?? "null") ?? fallback
    );
  } catch {
    return fallback;
  }
};
const persist = (key: string, value: unknown) =>
  localStorage.setItem(`localtex.${key}`, JSON.stringify(value));
const filename = (path: string) =>
  path.replaceAll("\\", "/").split("/").at(-1) ?? path;

export default function App() {
  const [project, setProject] = useState<Project | null>(null),
    projectRef = useRef<Project | null>(null);
  const buffers = useRef(new Map<string, BufferFile>());
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState("");
  const activeRef = useRef("");
  const [bufferVersion, setBufferVersion] = useState(0);
  const [, setDirtyVersion] = useState(0);
  const editor = useRef<EditorView | null>(null);
  const [documents, setDocuments] = useState<DocumentFile[]>([]);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    readPreference("theme", "light"),
  );
  const [mode, setMode] = useState<"write" | "review">(() =>
    readPreference("mode", "review"),
  );
  const [sidebar, setSidebar] = useState(true);
  const [sideTab, setSideTab] = useState<"files" | "outline" | "search">(
    "files",
  );
  const [query, setQuery] = useState("");
  const [split, setSplit] = useState(() => readPreference("split", 52));
  const [settings, setSettings] = useState<Settings>({
    recent: [],
    toolDirectory: null,
  });
  const [modal, setModal] = useState<
    "settings" | "new" | "file" | "rename" | "commands" | "help" | null
  >(null);
  const [newName, setNewName] = useState("Untitled research");
  const [template, setTemplate] = useState<"article" | "thesis">("article");
  const [fileName, setFileName] = useState("");
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [checking, setChecking] = useState(false);
  const [toolMessage, setToolMessage] = useState("");
  const [toolDir, setToolDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [autoCompile, setAutoCompile] = useState(() =>
    readPreference("autoCompileOnEdit", true),
  );
  const [commonPackages, setCommonPackages] = useState(() =>
    readPreference("commonPackages", true),
  );
  const [preparingPackages, setPreparingPackages] = useState(false);
  const packageRequests = useRef(new Map<string, Promise<string>>());
  const preparedDirectories = useRef(new Set<string>());
  const [buildStatus, setBuildStatus] = useState<
    "idle" | "running" | "success" | "failed" | "cancelled"
  >("idle");
  const buildId = useRef<string | null>(null);
  const queued = useRef(false);
  const buildRoot = useRef<string | null>(null);
  const [log, setLog] = useState("");
  const logRef = useRef("");
  const [showOutput, setShowOutput] = useState(false);
  const [outputTab, setOutputTab] = useState<"issues" | "log">("issues");
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [pdfStale, setPdfStale] = useState(false);
  const [sync, setSync] = useState<SyncPoint | null>(null);
  const [recovery, setRecovery] = useState<Draft[]>([]);
  const [commandQuery, setCommandQuery] = useState("");
  const [savedAt, setSavedAt] = useState("All changes saved");
  const editSerial = useRef(0),
    buildSerial = useRef(0);
  const saves = useRef(new SerialQueue());
  const recoveryWrites = useRef(new SerialQueue());
  const startingBuild = useRef(false);
  const indexTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actions = useRef({
    build: async (_automatic = false) => {},
    external: async () => {},
    event: async (_e: BuildEvent) => {},
    save: async () => {},
    open: async () => {},
    safeLeave: async () => true,
    sync: async () => {},
  });
  const buffer = buffers.current.get(active);
  const dirty = Array.from(buffers.current.values()).some(
    (b) => b.text !== b.savedText,
  );
  const issues = useMemo(() => diagnostics(log), [log]);
  const sections = useMemo(() => outline(documents), [documents]);
  const results = useMemo(
    () => searchProject(documents, query),
    [documents, query],
  );
  const buildOptions = project
    ? resolveBuild(project, buffer)
    : { root: null, engine: "pdflatex" as Engine };
  const notify = useCallback(
    (message: unknown) => setNotice(String(message)),
    [],
  );
  function updateProject(p: Project | null) {
    projectRef.current = p;
    setProject(p);
  }
  function selectActive(path: string) {
    activeRef.current = path;
    setActive(path);
    setCursor({ line: 1, column: 1 });
  }
  function currentDocs() {
    return documents.map((d) => buffers.current.get(d.path) ?? d);
  }
  function refreshIndex() {
    setDocuments(
      currentDocs().map((d) => ({
        path: d.path,
        text: d.text,
        revision: d.revision,
      })),
    );
  }
  async function ask(message: string) {
    return desktop
      ? confirm(message, { title: "localTEX", kind: "warning" })
      : window.confirm(message);
  }
  async function discardDraft(path: string) {
    const id = projectRef.current?.id;
    await recoveryWrites.current.run(async () => {
      if (desktop && id) await api.removeDraft(id, path);
      else localStorage.removeItem(`localtex.draft.${path}`);
    });
  }
  async function persistDrafts() {
    const p = projectRef.current;
    if (!p) return;
    for (const b of buffers.current.values()) {
      if (b.text !== b.savedText) {
        if (desktop)
          await recoveryWrites.current.run(() =>
            api.draft({
              project: p.id,
              path: b.path,
              text: b.text,
              revision: b.revision,
            }),
          );
        else persist(`draft.${b.path}`, b.text);
      }
    }
  }
  async function saveAll(scheduleBuild = true) {
    return saves.current.run(() => saveBuffers(scheduleBuild));
  }
  async function saveBuffers(scheduleBuild: boolean) {
    const p = projectRef.current;
    if (!p) return;
    for (const b of buffers.current.values()) {
      if (b.text === b.savedText) continue;
      if (b.conflict || b.missing)
        throw new Error(
          `Resolve the external change in ${b.path} before saving.`,
        );
      const text = b.text;
      const revision = desktop
        ? await api.save(p.id, { path: b.path, text, revision: b.revision })
        : "demo";
      b.revision = revision;
      b.savedText = text;
      if (b.text === text) await discardDraft(b.path);
      if (!desktop) persist(`demo.${b.path}`, text);
    }
    setDirtyVersion((v) => v + 1);
    setSavedAt("All changes saved");
    refreshIndex();
    if (scheduleBuild) scheduleAutoCompile();
  }
  function scheduleAutoCompile() {
    if (autoTimer.current) clearTimeout(autoTimer.current);
    if (!autoCompile || !desktop) return;
    const id = projectRef.current?.id;
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      if (id === projectRef.current?.id) void actions.current.build(true);
    }, 1200);
  }
  async function prepareCommonPackages(
    directory: string | null,
    retry = false,
  ) {
    const key = directory ?? "PATH";
    if (retry && !preparingPackages) {
      packageRequests.current.delete(key);
      preparedDirectories.current.delete(key);
    }
    if (preparedDirectories.current.has(key))
      return packageRequests.current.get(key)!;
    let request = packageRequests.current.get(key);
    if (!request) {
      request = api.preparePackages(directory);
      packageRequests.current.set(key, request);
    }
    setPreparingPackages(true);
    setToolMessage(
      "Preparing common LaTeX packages… First setup may download packages and take several minutes.",
    );
    try {
      const message = await request;
      preparedDirectories.current.add(key);
      setToolMessage(message);
      return message;
    } catch (e) {
      setToolMessage(String(e));
      throw e;
    } finally {
      setPreparingPackages(false);
    }
  }
  async function safeLeave() {
    if (autoTimer.current) clearTimeout(autoTimer.current);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (indexTimer.current) clearTimeout(indexTimer.current);
    if (buildId.current || startingBuild.current) {
      notify("Cancel the current build before leaving this project.");
      return false;
    }
    if (
      !Array.from(buffers.current.values()).some((b) => b.text !== b.savedText)
    )
      return true;
    if (await ask("Save your changes before continuing?")) {
      try {
        await saveAll(false);
        return true;
      } catch (e) {
        notify(e);
        return false;
      }
    }
    if (await ask("Discard unsaved changes and continue?")) {
      for (const b of buffers.current.values()) await discardDraft(b.path);
      return true;
    }
    return false;
  }
  async function openFile(path: string, line?: number) {
    const p = projectRef.current;
    if (!p) return;
    try {
      if (!buffers.current.has(path)) {
        const doc = desktop
          ? await api.read(p.id, path)
          : documents.find((d) => d.path === path);
        if (!doc) throw new Error("This file is unavailable.");
        buffers.current.set(path, { ...doc, savedText: doc.text });
      }
      setTabs((old) => (old.includes(path) ? old : [...old, path]));
      selectActive(path);
      if (line)
        requestAnimationFrame(() =>
          requestAnimationFrame(() => jumpToLine(line)),
        );
    } catch (e) {
      notify(e);
    }
  }
  function jumpToLine(line: number) {
    const view = editor.current;
    if (!view) return;
    const target = view.state.doc.line(
      Math.max(1, Math.min(line, view.state.doc.lines)),
    );
    view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
    view.focus();
  }
  async function loadProject(directory: string) {
    if (!(await safeLeave())) return;
    setBusy(true);
    try {
      const p = await api.open(directory);
      clearEditorStates();
      buffers.current.clear();
      setTabs([]);
      selectActive("");
      updateProject(p);
      setPdf(null);
      setPdfStale(false);
      setLog("");
      logRef.current = "";
      setBuildStatus("idle");
      buildRoot.current = null;
      setRecovery([]);
      const next = {
        ...settings,
        recent: [
          p.directory,
          ...settings.recent.filter((r) => r !== p.directory),
        ].slice(0, 8),
      };
      setSettings(next);
      await api.saveSettings(next);
      const docs = await api.index(p.id);
      setDocuments(docs);
      setRecovery(await api.drafts(p.id));
      const first =
        resolveBuild(p).root ??
        p.files.find((f) => f.path.endsWith(".tex"))?.path;
      if (first) {
        const doc = await api.read(p.id, first);
        buffers.current.set(first, { ...doc, savedText: doc.text });
        setTabs([first]);
        selectActive(first);
      }
    } catch (e) {
      notify(e);
    } finally {
      setBusy(false);
    }
  }
  async function openFolder() {
    if (!desktop) {
      notify(
        "Open the desktop app to work with folders on your computer. You can explore the editor with the sample project.",
      );
      return;
    }
    const path = await open({
      directory: true,
      multiple: false,
      title: "Open a LaTeX project",
    });
    if (typeof path === "string") await loadProject(path);
  }
  async function createProject() {
    if (!desktop) {
      loadDemo();
      setModal(null);
      return;
    }
    setBusy(true);
    try {
      const parent = await open({
        directory: true,
        multiple: false,
        title: "Choose where to create your project",
      });
      if (typeof parent === "string") {
        const path = await api.create(parent, newName, template);
        setModal(null);
        await loadProject(path);
      }
    } catch (e) {
      notify(e);
    } finally {
      setBusy(false);
    }
  }
  function loadDemo() {
    const docs = demoDocuments.map((d) => ({
      ...d,
      text: readPreference(`demo.${d.path}`, d.text),
    }));
    clearEditorStates();
    buffers.current.clear();
    docs.forEach((d) =>
      buffers.current.set(d.path, { ...d, savedText: d.text }),
    );
    updateProject(demoProject);
    setDocuments(docs);
    setTabs(["main.tex"]);
    selectActive("main.tex");
    const drafts = docs.flatMap((d) => {
      const text = readPreference<string | null>(`draft.${d.path}`, null);
      return text && text !== d.text
        ? [{ ...d, text, project: "preview" }]
        : [];
    });
    setRecovery(drafts);
  }
  async function closeTab(path: string) {
    const b = buffers.current.get(path);
    if (b && b.text !== b.savedText) {
      if (
        !(await ask(
          `Discard unsaved edits in ${filename(path)}? Save with Ctrl+S to keep them.`,
        ))
      )
        return;
      await discardDraft(path);
    }
    buffers.current.delete(path);
    if (b)
      setDocuments((docs) =>
        docs.map((d) =>
          d.path === path
            ? { path: b.path, text: b.savedText, revision: b.revision }
            : d,
        ),
      );
    forgetEditorState(`${project?.id}:${path}:${bufferVersion}`);
    setTabs((old) => {
      const next = old.filter((p) => p !== path);
      if (active === path) selectActive(next.at(-1) ?? "");
      return next;
    });
  }
  function changed(text: string) {
    const b = buffers.current.get(activeRef.current);
    if (!b) return;
    const wasDirty = b.text !== b.savedText;
    b.text = text;
    editSerial.current++;
    scheduleAutoCompile();
    if (!wasDirty || text === b.savedText) setDirtyVersion((v) => v + 1);
    setPdfStale(true);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(
      () => void persistDrafts().catch(notify),
      650,
    );
    if (indexTimer.current) clearTimeout(indexTimer.current);
    indexTimer.current = setTimeout(() => {
      refreshIndex();
      setSavedAt(
        text === b.savedText
          ? "All changes saved"
          : "Unsaved changes · recovery enabled",
      );
    }, 400);
  }
  async function build(automatic = false) {
    const p = projectRef.current;
    if (!p) return;
    if (!desktop) {
      notify(
        "Compilation runs locally in the Windows desktop app. This browser preview lets you explore the editor.",
      );
      return;
    }
    if (buildId.current || startingBuild.current) {
      queued.current = true;
      notify("Your next build is queued.");
      return;
    }
    startingBuild.current = true;
    queued.current = false;
    try {
      if (autoTimer.current) clearTimeout(autoTimer.current);
      const options = resolveBuild(p, buffers.current.get(activeRef.current));
      if (!options.root) {
        setModal("settings");
        notify("Choose a root document in Project settings before compiling.");
        return;
      }
      if (commonPackages) await prepareCommonPackages(settings.toolDirectory);
      // Capture before asynchronous saving so edits made during the save mark the PDF stale.
      const serial = editSerial.current;
      await saveAll(false);
      const id = crypto.randomUUID();
      buildId.current = id;
      buildRoot.current = options.root;
      buildSerial.current = serial;
      setBuildStatus("running");
      setPdfStale(true);
      logRef.current = "";
      setLog("");
      await api.build(
        p.id,
        id,
        options.root,
        options.engine,
        settings.toolDirectory,
        !automatic || buildStatus === "failed" || buildStatus === "cancelled",
      );
    } catch (e) {
      buildId.current = null;
      setBuildStatus("failed");
      queued.current = false;
      if (automatic) setAutoCompile(false);
      notify(automatic ? `Auto compile paused: ${e}` : e);
    } finally {
      startingBuild.current = false;
    }
  }
  async function buildEvent(event: BuildEvent) {
    if (
      event.projectId !== projectRef.current?.id ||
      event.buildId !== buildId.current
    )
      return;
    if (event.kind === "output") {
      logRef.current = (logRef.current + event.text + "\n").slice(-250000);
      return;
    }
    if (event.kind === "finished") {
      buildId.current = null;
      setLog(logRef.current);
      setBuildStatus(
        event.success
          ? "success"
          : event.text.includes("cancelled")
            ? "cancelled"
            : "failed",
      );
      if (event.success) {
        try {
          setPdf(await api.pdf(event.projectId));
          setPdfStale(editSerial.current !== buildSerial.current);
        } catch (e) {
          notify(e);
        }
      } else {
        setPdfStale(true);
        setShowOutput(true);
        if (!diagnostics(logRef.current).length) setOutputTab("log");
      }
      if (queued.current) {
        queued.current = false;
        void actions.current.build();
      }
    }
  }
  async function cancelBuild() {
    if (!project) return;
    queued.current = false;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    try {
      await api.cancel(project.id);
    } catch (e) {
      notify(e);
    }
  }
  async function externalChanges() {
    const p = projectRef.current;
    if (!p) return;
    try {
      const refreshed = await api.refresh(p.id);
      if (projectRef.current?.id !== p.id) return;
      updateProject(refreshed);
      for (const b of buffers.current.values()) {
        if (!refreshed.files.some((f) => f.path === b.path)) {
          b.missing = true;
          editSerial.current++;
          setPdfStale(true);
          continue;
        }
        const disk = await api.read(p.id, b.path);
        if (disk.revision === b.revision) {
          b.missing = false;
          continue;
        }
        editSerial.current++;
        if (b.text !== b.savedText) {
          b.conflict = disk;
        } else {
          Object.assign(b, { ...disk, savedText: disk.text, missing: false });
          if (b.path === activeRef.current) setBufferVersion((v) => v + 1);
        }
        setPdfStale(true);
      }
      setDirtyVersion((v) => v + 1);
      const docs = await api.index(p.id);
      if (projectRef.current?.id === p.id)
        setDocuments(docs.map((d) => buffers.current.get(d.path) ?? d));
    } catch (e) {
      notify(e);
    }
  }
  async function resolveConflict(keep: boolean) {
    const b = buffers.current.get(active);
    if (!b?.conflict) return;
    if (
      keep &&
      !(await ask(
        "Replace the external version with your edits on the next save?",
      ))
    )
      return;
    if (!keep) {
      b.text = b.conflict.text;
      b.savedText = b.text;
      setBufferVersion((v) => v + 1);
      await discardDraft(b.path);
    } else b.savedText = b.conflict.text;
    b.revision = b.conflict.revision;
    b.conflict = undefined;
    setDirtyVersion((v) => v + 1);
    refreshIndex();
  }
  async function saveConfig(change: Partial<ProjectConfig>) {
    if (!project) return;
    try {
      const config = { ...project.config, ...change };
      if (desktop) await api.config(project.id, config);
      updateProject({ ...project, config });
      editSerial.current++;
      setPdfStale(true);
    } catch (e) {
      notify(e);
    }
  }
  async function syncForward() {
    if (!project || !pdf || !buildRoot.current) return;
    if (pdfStale) {
      notify("Compile your latest changes before synchronizing with the PDF.");
      return;
    }
    try {
      const fields = syncFields(
        await api.sync({
          projectId: project.id,
          directory: settings.toolDirectory,
          document: buildRoot.current,
          source: active,
          line: cursor.line,
        }),
      );
      if (!fields.Page)
        throw new Error(
          "No PDF position found for this line. Try a line of document text.",
        );
      setMode("review");
      setSync({
        page: Number(fields.Page),
        x: Number(fields.x ?? fields.h ?? 0),
        y: Number(fields.y ?? fields.v ?? 0),
      });
    } catch (e) {
      notify(e);
    }
  }
  async function syncInverse(point: SyncPoint) {
    if (!project || !buildRoot.current) return;
    if (pdfStale) {
      notify("Compile your latest changes before jumping to the source.");
      return;
    }
    try {
      const fields = syncFields(
        await api.sync({
          projectId: project.id,
          directory: settings.toolDirectory,
          document: buildRoot.current,
          ...point,
        }),
      );
      const path = relativeSource(project.directory, fields.Input ?? "");
      if (!path)
        throw new Error("This PDF position points outside the project.");
      await openFile(path, Number(fields.Line) || 1);
    } catch (e) {
      notify(e);
    }
  }
  async function exportPdf() {
    if (!project) return;
    try {
      const destination = await save({
        title: "Export PDF",
        defaultPath: `${project.name}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (destination) {
        await api.export(project.id, destination);
        notify("PDF exported.");
      }
    } catch (e) {
      notify(e);
    }
  }
  async function checkTools() {
    setChecking(true);
    setToolMessage("Checking the installed engines and build tools…");
    try {
      const next = { ...settings, toolDirectory: toolDir.trim() || null };
      setSettings(next);
      await api.saveSettings(next);
      const result = await api.tools(next.toolDirectory);
      setTools(result);
      if (
        commonPackages &&
        result.find((t) => t.name === "pdflatex")?.available
      ) {
        await prepareCommonPackages(next.toolDirectory, true);
        return;
      }
      setToolMessage(
        result.find((t) => t.name === "latexmk")?.available
          ? "Tools checked. Run a test build to confirm compilation."
          : "latexmk is not ready. Finish installation, including its Perl runtime, then check again.",
      );
    } catch (e) {
      setToolMessage(String(e));
    } finally {
      setChecking(false);
    }
  }
  async function testBuild() {
    setChecking(true);
    setToolMessage("Compiling a minimal document…");
    try {
      if (commonPackages) await prepareCommonPackages(toolDir.trim() || null);
      setToolMessage(
        await api.test(toolDir.trim() || null, buildOptions.engine),
      );
    } catch (e) {
      setToolMessage(String(e));
    } finally {
      setChecking(false);
    }
  }
  async function createOrRename() {
    if (!project) return;
    try {
      if (!fileName.trim()) return;
      if (desktop) {
        if (modal === "rename") {
          await saveAll(false);
          await api.rename(project.id, active, fileName.trim());
          const b = buffers.current.get(active);
          if (b) {
            buffers.current.delete(active);
            buffers.current.set(fileName.trim(), {
              ...b,
              path: fileName.trim(),
            });
          }
          setTabs((ts) => ts.map((t) => (t === active ? fileName.trim() : t)));
          if (project.config.root === active)
            await saveConfig({ root: fileName.trim() });
          selectActive(fileName.trim());
        } else await api.createFile(project.id, fileName.trim());
        await externalChanges();
        await openFile(fileName.trim());
      } else {
        notify("File creation and renaming are available in the desktop app.");
      }
      setModal(null);
    } catch (e) {
      notify(e);
    }
  }
  async function restoreDrafts() {
    editSerial.current++;
    setPdfStale(true);
    for (const draft of recovery) {
      let disk = documents.find((d) => d.path === draft.path);
      if (!disk) {
        notify(
          `Recovery for ${draft.path} is retained because its file is missing.`,
        );
        continue;
      }
      buffers.current.set(draft.path, {
        path: draft.path,
        text: draft.text,
        revision: disk.revision,
        savedText: disk.text,
        ...(draft.revision !== disk.revision ? { conflict: disk } : {}),
      });
      setTabs((ts) => (ts.includes(draft.path) ? ts : [...ts, draft.path]));
    }
    setBufferVersion((v) => v + 1);
    setDirtyVersion((v) => v + 1);
    refreshIndex();
    setRecovery([]);
    notify("Recovered edits are open. Review them, then save.");
  }
  actions.current = {
    build,
    external: externalChanges,
    event: buildEvent,
    save: saveAll,
    open: openFolder,
    safeLeave,
    sync: syncForward,
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    persist("theme", theme);
  }, [theme]);
  useEffect(() => {
    persist("mode", mode);
  }, [mode]);
  useEffect(() => {
    persist("split", split);
  }, [split]);
  useEffect(() => {
    persist("autoCompileOnEdit", autoCompile);
    if (!autoCompile) {
      if (autoTimer.current) clearTimeout(autoTimer.current);
      queued.current = false;
    }
  }, [autoCompile]);
  useEffect(() => {
    persist("commonPackages", commonPackages);
  }, [commonPackages]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 9000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (desktop)
      void api
        .settings()
        .then((s) => {
          setSettings(s);
          setToolDir(s.toolDirectory ?? "");
        })
        .catch(notify);
  }, [notify]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisteners: (() => void)[] = [];
    let externalTimer: ReturnType<typeof setTimeout> | undefined;
    const keep = (fn: () => void) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    };
    void api.onBuild((e) => void actions.current.event(e)).then(keep);
    void api
      .onFiles((e) => {
        if (e.projectId !== projectRef.current?.id) return;
        clearTimeout(externalTimer);
        externalTimer = setTimeout(() => void actions.current.external(), 350);
      })
      .then(keep);
    void getCurrentWindow()
      .onCloseRequested(async (e) => {
        e.preventDefault();
        if (await actions.current.safeLeave())
          await getCurrentWindow().destroy();
      })
      .then(keep);
    const timer = setInterval(() => {
      if (buildId.current) setLog(logRef.current);
    }, 150);
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
      clearInterval(timer);
      clearTimeout(externalTimer);
    };
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (
        ["s", "enter", "o", "k", "j", "b"].includes(e.key.toLowerCase()) ||
        (e.key.toLowerCase() === "l" && e.shiftKey)
      )
        e.stopPropagation();
      if (e.key === "s") {
        e.preventDefault();
        void actions.current.save().catch(notify);
      }
      if (e.key === "Enter") {
        e.preventDefault();
        void actions.current.build();
      }
      if (e.key.toLowerCase() === "o") {
        e.preventDefault();
        void actions.current.open();
      }
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setModal((m) => (m === "commands" ? null : "commands"));
        setCommandQuery("");
      }
      if (e.key.toLowerCase() === "j") {
        e.preventDefault();
        setMode((m) => (m === "write" ? "review" : "write"));
      }
      if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebar((s) => !s);
      }
      if (e.key.toLowerCase() === "l" && e.shiftKey) {
        e.preventDefault();
        void actions.current.sync();
      }
    };
    const before = (e: BeforeUnloadEvent) => {
      if (
        Array.from(buffers.current.values()).some((b) => b.text !== b.savedText)
      ) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler, true);
    window.addEventListener("beforeunload", before);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("beforeunload", before);
    };
  }, [notify]);
  const commandsList = [
    { label: "Compile project", hint: "Ctrl Enter", run: () => void build() },
    {
      label: "Save all files",
      hint: "Ctrl S",
      run: () => void saveAll().catch(notify),
    },
    {
      label: "Open project folder",
      hint: "Ctrl O",
      run: () => void openFolder(),
    },
    { label: "New project", hint: "", run: () => setModal("new") },
    {
      label: mode === "write" ? "Switch to Review" : "Switch to Write",
      hint: "Ctrl J",
      run: () => setMode((m) => (m === "write" ? "review" : "write")),
    },
    {
      label: "Jump to PDF",
      hint: "Ctrl Shift L",
      run: () => void syncForward(),
    },
    {
      label: "Toggle sidebar",
      hint: "Ctrl B",
      run: () => setSidebar((s) => !s),
    },
    {
      label: "Search project",
      hint: "",
      run: () => {
        setSidebar(true);
        setSideTab("search");
      },
    },
    {
      label: "Settings and LaTeX setup",
      hint: "",
      run: () => setModal("settings"),
    },
    {
      label: theme === "light" ? "Use graphite theme" : "Use paper theme",
      hint: "",
      run: () => setTheme((t) => (t === "light" ? "dark" : "light")),
    },
    ...(project?.files
      .filter((f) => f.editable)
      .map((f) => ({
        label: `Open ${f.path}`,
        hint: "File",
        run: () => void openFile(f.path),
      })) ?? []),
  ];
  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          className="brand"
          aria-label="localTEX home"
          onClick={() =>
            void safeLeave().then((ok) => {
              if (ok) {
                updateProject(null);
                setPdf(null);
              }
            })
          }
        >
          <span className="brand-mark">
            l<span>τ</span>
          </span>
          <span>
            local<span className="tex-word">TEX</span>
          </span>
          <span className="beta-tag">STUDIO</span>
        </button>
        <div className="project-breadcrumb">
          {project ? (
            <>
              <span className="breadcrumb-slash">/</span>
              <FolderOpen size={14} />
              <span>{project.name}</span>
              <ChevronDown size={12} />
            </>
          ) : (
            <span className="topbar-caption">
              A little space for big ideas.
            </span>
          )}
        </div>
        <div className="topbar-right">
          <span className="local-badge">
            <span /> LOCAL BY NATURE
          </span>
          <button
            className="icon-button"
            aria-label="Command palette"
            title="Command palette · Ctrl K"
            onClick={() => {
              setCommandQuery("");
              setModal("commands");
            }}
          >
            <Command size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Toggle theme"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          >
            {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <button
            className="icon-button"
            aria-label="Settings"
            onClick={() => setModal("settings")}
          >
            <Settings2 size={17} />
          </button>
        </div>
      </header>
      {!project ? (
        <main className="welcome">
          <div className="welcome-main">
            <div className="welcome-intro">
              <h1>
                <span className="hero-title-line">
                  <span className="hero-star" aria-hidden="true">
                    ✳
                  </span>
                  Big ideas.
                </span>
                <em>Your own space.</em>
              </h1>
              <p>
                A thoughtful home for your research.
                <br />
                Write, refine, and make something that matters.
              </p>
              <div className="welcome-actions">
                <button
                  className="button primary"
                  onClick={() => setModal("new")}
                >
                  <Plus size={17} /> New project <ArrowRight size={17} />
                </button>
                <button
                  className="button secondary"
                  onClick={() => void openFolder()}
                >
                  <FolderOpen size={17} /> Open folder
                </button>
              </div>
              <span className="welcome-note">
                <ShieldCheck size={14} /> On your machine. On your terms.
              </span>
            </div>
            <div className="welcome-art" aria-hidden="true">
              <span className="art-orbit orbit-one" />
              <span className="art-orbit orbit-two" />
              <div className="art-note note-one">a question worth asking.</div>
              <div className="art-paper">
                <span className="paper-kicker">NOTES ON POSSIBILITY</span>
                <h2>
                  It begins
                  <br />
                  with an idea.
                </h2>
                <div className="paper-author">Curiosity, meet clarity.</div>
                <div className="paper-hairline" />
                <span className="paper-section">01 &nbsp; Introduction</span>
                <p>
                  There is a quiet kind of magic in putting a thought on paper.
                  Giving it shape. Finding the words.
                </p>
                <div className="art-formula">∫ ideas · dt = discovery</div>
                <div className="art-lines">
                  <i />
                  <i />
                  <i />
                </div>
                <span className="paper-page">1</span>
              </div>
              <div className="art-note note-two">
                <CheckCircle2 size={14} /> Compiled with care
              </div>
              <span className="art-spark">✳</span>
            </div>
          </div>
          <div className="welcome-bottom">
            <section className="recent-projects">
              <div className="section-heading">
                <h2>Pick up where you left off</h2>
                <span>
                  {settings.recent.length
                    ? `${settings.recent.length} recent projects`
                    : "A fresh page awaits"}
                </span>
              </div>
              {settings.recent.length ? (
                settings.recent.map((path) => (
                  <button
                    key={path}
                    className="recent-row"
                    onClick={() => void loadProject(path)}
                  >
                    <span className="project-icon">
                      <FileText size={20} />
                    </span>
                    <span>
                      <strong>{filename(path)}</strong>
                      <small>{path.replace(/^\\\\\?\\/, "")}</small>
                    </span>
                    <ArrowRight size={17} />
                  </button>
                ))
              ) : (
                <div className="first-project">
                  <BookOpen size={24} />
                  <div>
                    <strong>Make room for your next idea.</strong>
                    <p>
                      Open an existing LaTeX folder or begin with a carefully
                      prepared template.
                    </p>
                  </div>
                </div>
              )}
            </section>
            {!desktop && (
              <button className="text-button" onClick={loadDemo}>
                Explore the browser preview <ArrowRight size={14} />
              </button>
            )}
          </div>
          <footer className="welcome-footer">
            <button className="text-button" onClick={() => setModal("help")}>
              Make yourself at home <ArrowRight size={13} />
            </button>
            <span>localTEX 0.1</span>
          </footer>
        </main>
      ) : (
        <>
          <div className="workspace-toolbar">
            <div className="workspace-title">
              <button
                className="icon-button"
                aria-label="Toggle sidebar"
                onClick={() => setSidebar((v) => !v)}
              >
                {sidebar ? (
                  <PanelLeftClose size={17} />
                ) : (
                  <PanelLeftOpen size={17} />
                )}
              </button>
              <span className="toolbar-divider" />
              <span className="project-type">
                {project.files.some((f) => f.path === "introduction.tex")
                  ? "Thesis"
                  : "Research project"}
              </span>
              {!desktop && (
                <span className="preview-label">Browser preview</span>
              )}
            </div>
            <div className="mode-switch" aria-label="Workspace layout">
              <button
                className={mode === "write" ? "active" : ""}
                onClick={() => setMode("write")}
              >
                <Maximize2 size={13} /> Write
              </button>
              <button
                className={mode === "review" ? "active" : ""}
                onClick={() => setMode("review")}
              >
                <BookOpen size={14} /> Review
              </button>
            </div>
            <div className="compile-actions">
              <button
                className="button secondary"
                aria-label="Auto compile"
                aria-pressed={autoCompile}
                title="Save and compile after a pause in typing"
                onClick={() => setAutoCompile((value) => !value)}
              >
                Auto {autoCompile ? "on" : "off"}
              </button>
              <button
                className="icon-button save-button"
                title="Save all · Ctrl S"
                aria-label="Save all"
                onClick={() => void saveAll().catch(notify)}
              >
                <ArrowDownToLine size={17} />
              </button>
              {preparingPackages ? (
                <button className="button compile-button" disabled>
                  <Loader2 size={14} className="spin" /> Preparing packages…
                </button>
              ) : buildStatus === "running" ? (
                <>
                  <button
                    className="button compile-button"
                    onClick={() => void build()}
                  >
                    <Loader2 size={14} className="spin" /> Compiling
                  </button>
                  <button
                    aria-label="Cancel build"
                    className="icon-button"
                    onClick={() => void cancelBuild()}
                  >
                    <Square size={15} />
                  </button>
                </>
              ) : (
                <button
                  className="button compile-button"
                  onClick={() => void build()}
                >
                  <Play size={14} fill="currentColor" /> Compile <kbd>⌃ ↵</kbd>
                </button>
              )}
            </div>
          </div>
          {recovery.length > 0 && (
            <div className="recovery-banner">
              <Sparkles size={16} />
              <span>
                We kept your place. {recovery.length} file(s) have recoverable
                edits.
              </span>
              <button onClick={() => void restoreDrafts()}>
                Restore edits
              </button>
              <button
                onClick={() =>
                  void ask("Permanently discard these recovery drafts?").then(
                    async (ok) => {
                      if (ok) {
                        for (const d of recovery) await discardDraft(d.path);
                        setRecovery([]);
                      }
                    },
                  )
                }
              >
                Discard
              </button>
            </div>
          )}
          <div className="workspace-body">
            {sidebar && (
              <aside className="sidebar">
                <div className="sidebar-tabs">
                  <button
                    aria-label="Project files"
                    className={sideTab === "files" ? "active" : ""}
                    onClick={() => setSideTab("files")}
                  >
                    <Files size={16} />
                  </button>
                  <button
                    aria-label="Document outline"
                    className={sideTab === "outline" ? "active" : ""}
                    onClick={() => setSideTab("outline")}
                  >
                    <ListTree size={17} />
                  </button>
                  <button
                    aria-label="Search project"
                    className={sideTab === "search" ? "active" : ""}
                    onClick={() => setSideTab("search")}
                  >
                    <Search size={16} />
                  </button>
                </div>
                <div className="sidebar-heading">
                  <span>
                    {sideTab === "files"
                      ? "PROJECT"
                      : sideTab === "outline"
                        ? "DOCUMENT OUTLINE"
                        : "FIND IN PROJECT"}
                  </span>
                  {sideTab === "files" && (
                    <button
                      className="icon-button"
                      aria-label="New file"
                      onClick={() => {
                        setFileName("untitled.tex");
                        setModal("file");
                      }}
                    >
                      <FilePlus2 size={14} />
                    </button>
                  )}
                </div>
                <div className="sidebar-content">
                  {sideTab === "files" ? (
                    <>
                      <div className="tree-root">
                        <ChevronDown size={13} />
                        <FolderOpen size={14} />
                        <span>{project.name}</span>
                      </div>
                      {project.files.map((f) => (
                        <button
                          key={f.path}
                          className={`file-row ${active === f.path ? "active" : ""}`}
                          disabled={!f.editable}
                          title={f.path}
                          onClick={() => void openFile(f.path)}
                        >
                          <span
                            className={`file-glyph ${f.path.endsWith(".bib") ? "bib" : ""}`}
                          >
                            {f.path.endsWith(".tex")
                              ? "T"
                              : f.path.endsWith(".bib")
                                ? "B"
                                : "·"}
                          </span>
                          <span>{f.path}</span>
                          {buffers.current.get(f.path)?.text !==
                            buffers.current.get(f.path)?.savedText && (
                            <span className="dirty-dot" />
                          )}
                        </button>
                      ))}
                      {active && (
                        <button
                          className="text-button rename-link"
                          onClick={() => {
                            setFileName(active);
                            setModal("rename");
                          }}
                        >
                          Rename selected file
                        </button>
                      )}
                    </>
                  ) : sideTab === "outline" ? (
                    sections.length ? (
                      sections.map((s, i) => (
                        <button
                          key={`${s.path}-${i}`}
                          className="outline-row"
                          style={{
                            paddingLeft: 12 + Math.max(0, s.level - 1) * 12,
                          }}
                          onClick={() => void openFile(s.path, s.line)}
                        >
                          <Hash size={12} />
                          <span>{s.title}</span>
                        </button>
                      ))
                    ) : (
                      <p className="sidebar-empty">
                        Your chapters and sections will appear here as you
                        write.
                      </p>
                    )
                  ) : (
                    <>
                      <label className="search-field">
                        <Search size={14} />
                        <input
                          aria-label="Search project text"
                          placeholder="Find a thought…"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </label>
                      {query && (
                        <p className="search-count">
                          {results.length}
                          {results.length === 200 ? "+" : ""} matches
                        </p>
                      )}
                      {results.map((r, i) => (
                        <button
                          className="search-result"
                          key={i}
                          onClick={() => void openFile(r.path, r.line)}
                        >
                          <strong>
                            {filename(r.path)} <span>:{r.line}</span>
                          </strong>
                          <small>{r.text}</small>
                        </button>
                      ))}
                    </>
                  )}
                </div>
                <div className="sidebar-bottom">
                  <div>
                    <ShieldCheck size={14} />
                    <span>Everything stays here.</span>
                  </div>
                  <span>Files live in your project folder.</span>
                </div>
              </aside>
            )}
            <main className={`editing-area ${mode}`}>
              <div
                className="panes"
                style={{ "--editor-width": `${split}%` } as React.CSSProperties}
              >
                <section className="editor-pane" aria-label="Source workspace">
                  <div className="editor-tabs">
                    {tabs.map((path) => (
                      <div
                        className={`editor-tab ${path === active ? "active" : ""}`}
                        key={path}
                      >
                        <button onClick={() => selectActive(path)}>
                          <span className="file-glyph">
                            {path.endsWith(".bib") ? "B" : "T"}
                          </span>
                          {filename(path)}
                          {buffers.current.get(path)?.text !==
                            buffers.current.get(path)?.savedText && (
                            <span className="dirty-dot" />
                          )}
                        </button>
                        <button
                          aria-label={`Close ${filename(path)}`}
                          className="tab-close"
                          onClick={() => void closeTab(path)}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                    <button
                      className="icon-button tab-plus"
                      aria-label="Create file"
                      onClick={() => {
                        setFileName("untitled.tex");
                        setModal("file");
                      }}
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                  <div className="source-breadcrumb">
                    <span>{active || "No file selected"}</span>
                    <span className="source-breadcrumb-right">
                      {buffer?.path.endsWith(".bib") ? "BIBLIOGRAPHY" : "LATEX"}
                      <button
                        className="icon-button"
                        aria-label="Jump to PDF"
                        title="Jump to PDF · Ctrl Shift L"
                        disabled={!pdf}
                        onClick={() => void syncForward()}
                      >
                        <ArrowRight size={14} />
                      </button>
                    </span>
                  </div>
                  {buffer?.conflict && (
                    <div className="conflict-banner">
                      <TriangleAlert size={15} />
                      <span>This file changed outside localTEX.</span>
                      <button onClick={() => void resolveConflict(false)}>
                        Use disk version
                      </button>
                      <button onClick={() => void resolveConflict(true)}>
                        Keep my edits
                      </button>
                    </div>
                  )}
                  {buffer?.missing && (
                    <div className="conflict-banner">
                      <TriangleAlert size={15} />
                      <span>
                        This file was moved or deleted. Copy your edits before
                        closing the tab.
                      </span>
                    </div>
                  )}
                  {buffer ? (
                    <Editor
                      bufferKey={`${project.id}:${active}:${bufferVersion}`}
                      initialText={buffer.text}
                      documents={documents}
                      diagnostics={issues.filter((issue) =>
                        issue.path
                          ? relativeSource(project.directory, issue.path) ===
                            active
                          : active === buildRoot.current,
                      )}
                      onChange={changed}
                      onCursor={(line, column) => setCursor({ line, column })}
                      onReady={(view) => {
                        editor.current = view;
                      }}
                    />
                  ) : (
                    <div className="empty-state">
                      <FileText />
                      <h3>A clear space to think.</h3>
                      <p>Choose a file from your project to begin.</p>
                    </div>
                  )}
                </section>
                <div
                  className="pane-resizer"
                  role="separator"
                  aria-label="Resize source and PDF panes"
                  aria-orientation="vertical"
                  aria-valuenow={Math.round(split)}
                  tabIndex={mode === "review" ? 0 : -1}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft") {
                      e.preventDefault();
                      setSplit((s) => Math.max(30, s - 2));
                    }
                    if (e.key === "ArrowRight") {
                      e.preventDefault();
                      setSplit((s) => Math.min(75, s + 2));
                    }
                  }}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      const rect =
                        e.currentTarget.parentElement!.getBoundingClientRect();
                      setSplit(
                        Math.max(
                          30,
                          Math.min(
                            75,
                            ((e.clientX - rect.left) / rect.width) * 100,
                          ),
                        ),
                      );
                    }
                  }}
                  onPointerUp={(e) => {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }}
                />
                <PdfPreview
                  data={pdf}
                  stale={pdfStale}
                  sync={sync}
                  onInverse={(point) => void syncInverse(point)}
                  onExport={() => void exportPdf()}
                />
              </div>
              {showOutput && (
                <section className="output-panel">
                  <div className="output-header">
                    <button
                      className={outputTab === "issues" ? "active" : ""}
                      onClick={() => setOutputTab("issues")}
                    >
                      Problems <span>{issues.length}</span>
                    </button>
                    <button
                      className={outputTab === "log" ? "active" : ""}
                      onClick={() => setOutputTab("log")}
                    >
                      Compiler output
                    </button>
                    <span className="output-spacer" />
                    <button
                      className="icon-button"
                      aria-label="Close compiler output"
                      onClick={() => setShowOutput(false)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {outputTab === "log" ? (
                    <pre className="compiler-log">
                      {log ||
                        "Your compiler output will appear here. Everything runs on your machine."}
                    </pre>
                  ) : (
                    <div className="issues-list">
                      {issues.length ? (
                        issues.map((issue, i) => (
                          <button
                            className={`issue ${issue.severity}`}
                            key={i}
                            onClick={() => {
                              const path = issue.path
                                ? relativeSource(project.directory, issue.path)
                                : buildRoot.current;
                              if (path) void openFile(path, issue.line ?? 1);
                            }}
                          >
                            <TriangleAlert size={14} />
                            <span>{issue.message}</span>
                            <small>
                              {issue.path ? filename(issue.path) : ""}
                              {issue.line ? `:${issue.line}` : ""}
                            </small>
                          </button>
                        ))
                      ) : (
                        <div className="no-issues">
                          <CheckCircle2 size={16} />{" "}
                          {buildStatus === "failed"
                            ? "No structured diagnostics found. See compiler output for details."
                            : "A little clarity. No reported problems."}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}
            </main>
          </div>
          <footer className="statusbar">
            <button
              className={`build-status ${buildStatus}`}
              onClick={() => setShowOutput((s) => !s)}
            >
              {buildStatus === "running" ? (
                <Loader2 className="spin" size={12} />
              ) : buildStatus === "success" ? (
                <CheckCircle2 size={12} />
              ) : buildStatus === "failed" ? (
                <TriangleAlert size={12} />
              ) : (
                <Terminal size={12} />
              )}
              <span>
                {buildStatus === "running"
                  ? "Compiling locally…"
                  : buildStatus === "success"
                    ? pdfStale
                      ? "Changes since last build"
                      : "Build complete"
                    : buildStatus === "failed"
                      ? "Build needs attention"
                      : buildStatus === "cancelled"
                        ? "Build cancelled"
                        : "Ready when you are"}
              </span>
              <ChevronRight size={11} />
            </button>
            <span className="status-saved">
              {dirty ? "Unsaved changes" : savedAt}
            </span>
            <span className="status-spacer" />
            <span>
              Ln {cursor.line}, Col {cursor.column}
            </span>
            <span>UTF-8</span>
            <button onClick={() => setModal("settings")}>
              {buildOptions.engine} <ChevronDown size={10} />
            </button>
            <span className="status-local">
              <span /> Local
            </span>
          </footer>
        </>
      )}
      {busy && (
        <div className="busy-indicator" role="status">
          <Loader2 size={15} className="spin" /> Opening your workspace…
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <CircleHelp size={18} />
          <span>{notice}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {modal === "new" && (
        <Modal title="Make room for an idea" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void createProject();
            }}
          >
            <p className="modal-intro">
              Start with a little structure. Make it your own.
            </p>
            <label className="field-label">
              Project name
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                maxLength={100}
              />
            </label>
            <div className="template-options">
              <button
                type="button"
                className={template === "article" ? "selected" : ""}
                onClick={() => setTemplate("article")}
              >
                <FileText size={24} />
                <strong>Research article</strong>
                <span>A clear, considered beginning.</span>
                {template === "article" && <Check size={15} />}
              </button>
              <button
                type="button"
                className={template === "thesis" ? "selected" : ""}
                onClick={() => setTemplate("thesis")}
              >
                <BookOpen size={24} />
                <strong>Thesis</strong>
                <span>A home for the bigger picture.</span>
                {template === "thesis" && <Check size={15} />}
              </button>
            </div>
            <div className="modal-footer">
              <span>
                <ShieldCheck size={13} /> Saved as ordinary local files
              </span>
              <button className="button primary" disabled={busy} type="submit">
                {desktop ? "Choose location" : "Explore sample"}
                <ArrowRight size={15} />
              </button>
            </div>
          </form>
        </Modal>
      )}
      {(modal === "file" || modal === "rename") && (
        <Modal
          title={modal === "rename" ? "Rename file" : "A fresh page"}
          onClose={() => setModal(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void createOrRename();
            }}
          >
            <p className="modal-intro">
              Use a path inside an existing project folder. Renaming does not
              rewrite LaTeX references.
            </p>
            <label className="field-label">
              File name
              <input
                autoFocus
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                required
              />
            </label>
            <div className="modal-footer">
              <span />
              <button className="button primary" type="submit">
                {modal === "rename" ? "Rename" : "Create file"}
                <ArrowRight size={15} />
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "settings" && (
        <Modal
          title="Make yourself at home"
          wide
          onClose={() => setModal(null)}
        >
          <div className="settings-body">
            <section>
              <h3>Workspace</h3>
              <div className="setting-row">
                <div>
                  <strong>Appearance</strong>
                  <p>A paper canvas or a quieter graphite workspace.</p>
                </div>
                <div className="segmented">
                  <button
                    className={theme === "light" ? "active" : ""}
                    onClick={() => setTheme("light")}
                  >
                    <Sun size={14} /> Paper
                  </button>
                  <button
                    className={theme === "dark" ? "active" : ""}
                    onClick={() => setTheme("dark")}
                  >
                    <Moon size={14} /> Graphite
                  </button>
                </div>
              </div>
              <label className="setting-row">
                <div>
                  <strong>Auto compile</strong>
                  <p>
                    Save and update the PDF after 1.2 seconds without typing.
                    Desktop app only.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={autoCompile}
                  onChange={(e) => setAutoCompile(e.target.checked)}
                />
              </label>
            </section>
            {project && (
              <section>
                <h3>Project</h3>
                <label className="field-label horizontal">
                  <span>Root document</span>
                  <select
                    value={project.config.root ?? ""}
                    onChange={(e) =>
                      void saveConfig({ root: e.target.value || null })
                    }
                  >
                    <option value="">Auto-detect / magic comment</option>
                    {project.files
                      .filter((f) => f.path.endsWith(".tex"))
                      .map((f) => (
                        <option key={f.path} value={f.path}>
                          {f.path}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="field-label horizontal">
                  <span>LaTeX engine</span>
                  <select
                    value={project.config.engine ?? ""}
                    onChange={(e) =>
                      void saveConfig({
                        engine: (e.target.value || null) as Engine | null,
                      })
                    }
                  >
                    <option value="">Auto (default: pdfLaTeX)</option>
                    <option value="pdflatex">pdfLaTeX</option>
                    <option value="xelatex">XeLaTeX</option>
                    <option value="lualatex">LuaLaTeX</option>
                  </select>
                </label>
                <label className="setting-row">
                  <div>
                    <strong>Trust this project with shell escape</strong>
                    <p>
                      Allows LaTeX to execute external programs on your
                      computer.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={project.config.shellEscape}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      if (!enabled) void saveConfig({ shellEscape: false });
                      else
                        void ask(
                          "Enable shell escape for this trusted project? Its LaTeX source will be able to run programs on your computer.",
                        ).then((ok) => {
                          if (ok) void saveConfig({ shellEscape: true });
                        });
                    }}
                  />
                </label>
              </section>
            )}
            <section>
              <h3>
                LaTeX setup{" "}
                <span className="section-tag">LOCAL COMPILATION</span>
              </h3>
              <p className="setting-description">
                Use MiKTeX or TeX Live, with latexmk and SyncTeX. MiKTeX also
                needs Perl for latexmk. Install missing packages through your
                distribution’s tools.
              </p>
              <label className="setting-row">
                <div>
                  <strong>Prepare common packages automatically</strong>
                  <p>
                    MiKTeX: maths, figures, tables, citations, diagrams and
                    fonts. Downloads missing packages before your first compile.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={commonPackages}
                  disabled={preparingPackages}
                  onChange={(e) => setCommonPackages(e.target.checked)}
                />
              </label>
              <label className="field-label">
                Executable folder{" "}
                <span className="optional">optional · otherwise uses PATH</span>
                <div className="input-with-button">
                  <input
                    value={toolDir}
                    onChange={(e) => setToolDir(e.target.value)}
                    placeholder="e.g. C:\Program Files\MiKTeX\miktex\bin\x64"
                  />
                  <button
                    className="icon-button"
                    aria-label="Choose executable folder"
                    disabled={!desktop}
                    onClick={() =>
                      void open({ directory: true, multiple: false }).then(
                        (p) => {
                          if (typeof p === "string") setToolDir(p);
                        },
                      )
                    }
                  >
                    <FolderOpen size={16} />
                  </button>
                </div>
              </label>
              <div className="setup-actions">
                <button
                  className="button secondary"
                  disabled={!desktop || checking || preparingPackages}
                  onClick={() => void checkTools()}
                >
                  {checking ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <CheckCircle2 size={14} />
                  )}{" "}
                  Save & check tools
                </button>
                <button
                  className="button secondary"
                  disabled={!desktop || checking || preparingPackages}
                  onClick={() => void testBuild()}
                >
                  <Play size={13} /> Test compilation
                </button>
                <button
                  className="button secondary"
                  disabled={
                    !desktop ||
                    checking ||
                    preparingPackages ||
                    buildStatus === "running"
                  }
                  onClick={() =>
                    void prepareCommonPackages(
                      toolDir.trim() || null,
                      true,
                    ).catch(notify)
                  }
                >
                  {preparingPackages ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <ArrowDownToLine size={14} />
                  )}
                  Install / repair common packages
                </button>
              </div>
              {toolMessage && (
                <pre className="tool-message" role="status">
                  {toolMessage}
                </pre>
              )}
              {tools.length > 0 && (
                <div className="tool-list">
                  {tools.map((t) => (
                    <details key={t.name}>
                      <summary>
                        {t.available ? (
                          <CheckCircle2 size={14} />
                        ) : (
                          <TriangleAlert size={14} />
                        )}
                        <strong>{t.name}</strong>
                        <span>{t.available ? "Ready" : "Needs attention"}</span>
                      </summary>
                      <pre>{t.detail}</pre>
                    </details>
                  ))}
                </div>
              )}
              <div className="setup-links">
                {[
                  ["Install MiKTeX", "https://miktex.org/download"],
                  ["Install TeX Live", "https://tug.org/texlive/"],
                  ["Install Perl", "https://strawberryperl.com/"],
                ].map(([label, url]) => (
                  <button
                    className="text-button"
                    key={label}
                    onClick={() => {
                      if (desktop) void openUrl(url).catch(notify);
                      else window.open(url, "_blank", "noopener,noreferrer");
                    }}
                  >
                    {label}
                    <ArrowRight size={12} />
                  </button>
                ))}
              </div>
            </section>
            <div className="privacy-note">
              <ShieldCheck size={19} />
              <div>
                <strong>Your work stays yours.</strong>
                <p>
                  No accounts, analytics, or cloud compilation. Fonts and PDF
                  rendering are bundled. Setup links open only when you choose
                  them.
                </p>
              </div>
            </div>
          </div>
        </Modal>
      )}
      {modal === "commands" && (
        <Modal
          title="What would you like to do?"
          onClose={() => setModal(null)}
        >
          <label className="command-search">
            <Search size={19} />
            <input
              autoFocus
              value={commandQuery}
              onChange={(e) => setCommandQuery(e.target.value)}
              placeholder="Find a command or a file…"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const first = commandsList.find((c) =>
                    c.label.toLowerCase().includes(commandQuery.toLowerCase()),
                  );
                  if (first) {
                    setModal(null);
                    first.run();
                  }
                }
              }}
            />
          </label>
          <div className="command-list">
            {commandsList
              .filter((c) =>
                c.label.toLowerCase().includes(commandQuery.toLowerCase()),
              )
              .map((c) => (
                <button
                  key={c.label}
                  onClick={() => {
                    setModal(null);
                    c.run();
                  }}
                >
                  <span>{c.label}</span>
                  <kbd>{c.hint}</kbd>
                </button>
              ))}
          </div>
        </Modal>
      )}
      {modal === "help" && (
        <Modal title="A few small shortcuts" onClose={() => setModal(null)}>
          <p className="modal-intro">
            Keep your hands on the keyboard and your mind on the idea.
          </p>
          <div className="shortcut-list">
            {[
              ["Compile locally", "Ctrl Enter"],
              ["Save all files", "Ctrl S"],
              ["Open project", "Ctrl O"],
              ["Command palette", "Ctrl K"],
              ["Write / Review", "Ctrl J"],
              ["Show / hide sidebar", "Ctrl B"],
              ["Jump from source to PDF", "Ctrl Shift L"],
              ["Find in current file", "Ctrl F"],
              ["Go to source", "Double-click PDF"],
            ].map(([label, key]) => (
              <div key={label}>
                <span>{label}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
          <p className="help-footnote">
            localTEX 0.1 · Built for a slower breath and a sharper thought.
          </p>
        </Modal>
      )}
    </div>
  );
}

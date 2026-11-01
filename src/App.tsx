import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import { openUrl as openUrlInBrowser } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { EditorView } from "@codemirror/view";
import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  FilePlus2,
  FolderPlus,
  FileText,
  Files,
  FolderOpen,
  Hash,
  Image,
  ListTree,
  Loader2,
  LocateFixed,
  Maximize2,
  Moon,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Terminal,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { api, desktop } from "./api";
import { Editor, clearEditorStates, forgetEditorState } from "./Editor";
import { PdfPreview } from "./PdfPreview";
import { Modal } from "./Modal";
import { SetupDialog } from "./Setup";
import { FileTree, previewable } from "./FileTree";
import { FilePreview } from "./FilePreview";
import { EditorToolbar } from "./EditorToolbar";
import {
  applySetupEvent,
  beginSetup,
  firstLine,
  idleSetup,
  setupProgress,
  type SetupView,
} from "./setupState";
import {
  countWords,
  diagnostics,
  requiredFiles,
  missingFiles,
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
  SetupEvent,
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
/** "bn-BD" becomes "Bangla (Bangladesh)", in the reader's own language. */
const languageName = (tag: string) => {
  try {
    return (
      new Intl.DisplayNames([navigator.language], { type: "language" }).of(tag) ??
      tag
    );
  } catch {
    return tag;
  }
};
const engineNames: Record<Engine, string> = {
  pdflatex: "pdfLaTeX",
  xelatex: "XeLaTeX",
  lualatex: "LuaLaTeX",
};

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
    | "settings"
    | "new"
    | "file"
    | "rename"
    | "commands"
    | "help"
    | "setup"
    | "folder"
    | null
  >(null);
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const [newName, setNewName] = useState("Untitled research");
  const [template, setTemplate] = useState<"article" | "thesis">("article");
  const [fileName, setFileName] = useState("");
  // The folder new files, folders and added files go into ("" is the project root).
  const [folder, setFolder] = useState("");
  const [renaming, setRenaming] = useState("");
  const [dropping, setDropping] = useState(false);
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [checking, setChecking] = useState(false);
  const [toolMessage, setToolMessage] = useState("");
  const [toolDir, setToolDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [autoCompile, setAutoCompile] = useState(() =>
    readPreference("autoCompileOnEdit", true),
  );
  const [downloadPackages, setDownloadPackages] = useState(() =>
    readPreference("downloadPackages", true),
  );
  const downloadRef = useRef(downloadPackages);
  downloadRef.current = downloadPackages;
  // Package and class files already checked this session, and the download in progress.
  const checkedFiles = useRef(new Set<string>());
  const packageFetch = useRef<Promise<void> | null>(null);
  const [fetchingPackages, setFetchingPackages] = useState(false);
  const [spellcheck, setSpellcheck] = useState(() =>
    readPreference("spellcheck", true),
  );
  const [spellLanguage, setSpellLanguage] = useState(() =>
    readPreference("spellLanguage", ""),
  );
  // Dictionaries installed in Windows, such as en-US or bn-BD.
  const [spellLanguages, setSpellLanguages] = useState<string[]>([]);
  const language = spellLanguages.includes(spellLanguage)
    ? spellLanguage
    : (spellLanguages.find(
        (l) => l.toLowerCase() === navigator.language.toLowerCase(),
      ) ??
      spellLanguages.find((l) => l.startsWith("en")) ??
      spellLanguages[0] ??
      "");
  const spelling = useMemo(
    () =>
      desktop && language
        ? {
            check: (text: string) => api.checkSpelling(language, text),
            suggest: (word: string) => api.spellingSuggestions(language, word),
            add: (word: string) => api.addToDictionary(language, word),
          }
        : null,
    [language],
  );
  const [setup, setSetupView] = useState<SetupView>(idleSetup);
  const setupRef = useRef(setup);
  // Setup streams many lines; apply them in batches instead of one render per line.
  const setupQueue = useRef<SetupEvent[]>([]);
  const setupFlush = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buildAfterSetup = useRef(false);
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
    build: async (_automatic = false, _install = false) => {},
    setup: (_e: SetupEvent) => {},
    drop: async (_paths: string[]) => {},
    packages: async () => {},
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
  const missing = useMemo(() => missingFiles(log), [log]);
  const sections = useMemo(() => outline(documents), [documents]);
  const results = useMemo(
    () => searchProject(documents, query),
    [documents, query],
  );
  const buildOptions = project
    ? resolveBuild(project, buffer, currentDocs())
    : { root: null, engine: "pdflatex" as Engine };
  // What "Auto" would choose, shown beside the engine setting.
  const autoEngine = project
    ? resolveBuild(
        { ...project, config: { ...project.config, engine: null } },
        buffer,
        currentDocs(),
      ).engine
    : "pdflatex";
  // The cursor's line, so the toolbar can show whether it is a heading.
  const currentLine = (() => {
    const doc = buffer ? editor.current?.state.doc : undefined;
    return doc ? doc.line(Math.min(cursor.line, doc.lines)).text : "";
  })();
  const rcFile = project?.files.find(
    (f) => f.path === "latexmkrc" || f.path === ".latexmkrc",
  )?.path;
  // The index refreshes shortly after typing pauses, so counting follows it.
  const words = useMemo(
    () => countWords(buildOptions.root, currentDocs()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documents, buildOptions.root],
  );
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
    const saved: DocumentFile[] = [];
    for (const b of buffers.current.values()) {
      if (b.text === b.savedText) continue;
      saved.push({ path: b.path, text: b.text, revision: b.revision });
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
    void ensurePackages(saved);
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
  function updateSetup(next: SetupView) {
    setupRef.current = next;
    setSetupView(next);
  }
  async function runSetup(directory = settings.toolDirectory) {
    if (!desktop || setupRef.current.status === "running") return;
    const runId = crypto.randomUUID();
    updateSetup(beginSetup(setupRef.current, runId));
    try {
      await api.startSetup(runId, directory);
    } catch (e) {
      updateSetup({
        ...setupRef.current,
        status: "failed",
        failure: { step: "tools", problem: "sample", text: String(e) },
      });
    }
  }
  function receiveSetup(event: SetupEvent) {
    // A reloaded window adopts the run that is still going in the background.
    if (setupRef.current.status === "running" && !setupRef.current.runId)
      updateSetup({ ...setupRef.current, runId: event.runId });
    setupQueue.current.push(event);
    if (event.kind === "finished") flushSetup();
    else setupFlush.current ??= setTimeout(flushSetup, 120);
  }
  function flushSetup() {
    if (setupFlush.current) clearTimeout(setupFlush.current);
    setupFlush.current = null;
    const events = setupQueue.current.splice(0);
    const next = events.reduce(applySetupEvent, setupRef.current);
    updateSetup(next);
    if (!events.some((e) => e.kind === "finished" && e.runId === next.runId))
      return;
    if (modalRef.current !== "setup") {
      if (next.status === "ready")
        notify("LaTeX is ready. Compiling now starts right away.");
      else if (next.failure?.problem !== "cancelled")
        notify("LaTeX setup needs attention. Open it from the top bar.");
    }
    if (next.status === "ready") void actions.current.packages();
    if (buildAfterSetup.current) {
      buildAfterSetup.current = false;
      void actions.current.build();
    }
  }
  /**
   * Downloads the packages and classes the documents load and MiKTeX lacks, before they
   * are compiled. Each file is checked once per session.
   */
  async function ensurePackages(docs: DocumentFile[]) {
    const p = projectRef.current;
    if (!desktop || !p || !downloadRef.current) return;
    if (setupRef.current.status === "running" || setupRef.current.miktex === false)
      return;
    const files = requiredFiles(
      docs,
      p.files.map((f) => f.path),
    ).filter((file) => !checkedFiles.current.has(file));
    if (!files.length) return;
    files.forEach((file) => checkedFiles.current.add(file));
    const { engine } = resolveBuild(p, buffers.current.get(activeRef.current), docs);
    const names = (list: string[]) =>
      list.map((file) => file.replace(/\.(?:sty|cls)$/, "")).join(", ");
    const run = (packageFetch.current ?? Promise.resolve()).then(async () => {
      setFetchingPackages(true);
      try {
        const result = await api.fetchPackages(settings.toolDirectory, engine, files);
        if (!result.supported) return;
        if (result.installed.length)
          notify(`Downloaded ${names(result.installed)} for this project.`);
        // Not retried this session: a typo or a file the project should contain.
        if (result.failed.length)
          notify(
            `Couldn’t download ${names(result.failed)}. If it’s your own file, add it to the project; otherwise check the name and your connection.`,
          );
      } catch {
        files.forEach((file) => checkedFiles.current.delete(file));
      } finally {
        if (packageFetch.current === run) {
          packageFetch.current = null;
          setFetchingPackages(false);
        }
      }
    });
    packageFetch.current = run;
    await run;
  }
  async function stopSetup() {
    try {
      await api.cancelSetup();
    } catch (e) {
      notify(e);
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
      // Images and PDFs open as a preview; they have no text buffer.
      const preview =
        previewable(path) && !p.files.find((f) => f.path === path)?.editable;
      if (!preview && !buffers.current.has(path)) {
        const doc = desktop
          ? await api.read(p.id, path)
          : documents.find((d) => d.path === path);
        if (!doc) throw new Error("This file is unavailable.");
        buffers.current.set(path, { ...doc, savedText: doc.text });
      }
      setTabs((old) => (old.includes(path) ? old : [...old, path]));
      selectActive(path);
      // New files go next to the one being worked on, as in Overleaf.
      setFolder(path.split("/").slice(0, -1).join("/"));
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
      void ensurePackages(docs);
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
  async function build(automatic = false, install = false) {
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
      const options = resolveBuild(
        p,
        buffers.current.get(activeRef.current),
        currentDocs(),
      );
      if (!options.root) {
        setModal("settings");
        notify("Choose a root document in Project settings before compiling.");
        return;
      }
      if (setupRef.current.status === "running") {
        // Compiling now would race the package installs; run once setup finishes.
        buildAfterSetup.current = true;
        if (!automatic)
          notify(
            "LaTeX setup is still running. Your build starts as soon as it finishes.",
          );
        return;
      }
      if (packageFetch.current) await packageFetch.current;
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
        !automatic ||
          install ||
          buildStatus === "failed" ||
          buildStatus === "cancelled",
        install || downloadPackages,
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
      const ready = ["pdflatex", "latexmk"].every(
        (name) => result.find((t) => t.name === name)?.available,
      );
      setToolMessage(
        ready
          ? "Tools checked. Run a test build to confirm compilation."
          : "latexmk is not ready. Finish installation, including its Perl runtime, then check again.",
      );
      // A different LaTeX folder needs its own package setup.
      if (ready && !(await api.setupStatus(next.toolDirectory)).complete) {
        setModal("setup");
        void runSetup(next.toolDirectory);
      }
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
      setToolMessage(
        await api.test(toolDir.trim() || null, buildOptions.engine),
      );
    } catch (e) {
      setToolMessage(String(e));
    } finally {
      setChecking(false);
    }
  }
  /** Paths at or inside `path`, which is a file or a folder. */
  const within = (path: string, candidate: string) =>
    candidate === path || candidate.startsWith(`${path}/`);
  async function createOrRename() {
    if (!project) return;
    const name = fileName.trim().replace(/^\/+|\/+$/g, "");
    try {
      if (!name) return;
      if (!desktop) {
        notify("Files and folders can be changed in the desktop app.");
        return;
      }
      if (modal === "rename") {
        await saveAll(false);
        await api.rename(project.id, renaming, name);
        // Open tabs follow the file, or every file inside a renamed folder.
        const moved = (path: string) =>
          within(renaming, path) ? name + path.slice(renaming.length) : path;
        for (const [path, b] of [...buffers.current]) {
          if (!within(renaming, path)) continue;
          buffers.current.delete(path);
          buffers.current.set(moved(path), { ...b, path: moved(path) });
        }
        setTabs((ts) => ts.map(moved));
        if (project.config.root && within(renaming, project.config.root))
          await saveConfig({ root: moved(project.config.root) });
        selectActive(moved(activeRef.current));
        await externalChanges();
      } else if (modal === "folder") {
        await api.createFolder(project.id, name);
        setFolder(name);
        await externalChanges();
      } else {
        await api.createFile(project.id, name);
        await externalChanges();
        await openFile(name);
      }
      setModal(null);
    } catch (e) {
      notify(e);
    }
  }
  async function deleteEntry(path: string, isFolder: boolean) {
    const p = projectRef.current;
    if (!p) return;
    if (!desktop) {
      notify("Files and folders can be changed in the desktop app.");
      return;
    }
    const unsaved = [...buffers.current.values()].some(
      (b) => within(path, b.path) && b.text !== b.savedText,
    );
    const what = isFolder ? `the folder ${path} and everything in it` : path;
    if (
      !(await ask(
        `Move ${what} to the Recycle Bin?${unsaved ? " Unsaved changes in it will be lost." : ""}`,
      ))
    )
      return;
    try {
      await api.remove(p.id, path);
      for (const buffered of [...buffers.current.keys()].filter((b) =>
        within(path, b),
      )) {
        buffers.current.delete(buffered);
        await discardDraft(buffered);
      }
      setTabs((old) => {
        const next = old.filter((t) => !within(path, t));
        if (within(path, activeRef.current)) selectActive(next.at(-1) ?? "");
        return next;
      });
      if (p.config.root && within(path, p.config.root))
        await saveConfig({ root: null });
      if (within(path, folder)) setFolder("");
      await externalChanges();
      notify(`Moved ${isFolder ? "the folder" : path} to the Recycle Bin.`);
    } catch (e) {
      notify(e);
    }
  }
  /** Copies files into the selected folder, from the Add files dialog or a drop. */
  async function importPaths(paths: string[]) {
    const p = projectRef.current;
    if (!p || !paths.length) return;
    try {
      const added = await api.importFiles(p.id, folder, paths);
      await externalChanges();
      notify(
        `Added ${added.length === 1 ? added[0] : `${added.length} files`} to ${folder || "the project"}.`,
      );
    } catch (e) {
      notify(e);
    }
  }
  async function addFiles() {
    if (!desktop) {
      notify("Files and folders can be changed in the desktop app.");
      return;
    }
    const picked = await open({
      multiple: true,
      title: `Add files to ${folder || "the project"}`,
    });
    if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
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
        encoding: disk.encoding,
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
    setup: receiveSetup,
    drop: importPaths,
    packages: () => ensurePackages(currentDocs()),
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
    persist("downloadPackages", downloadPackages);
    persist("spellcheck", spellcheck);
    persist("spellLanguage", spellLanguage);
  }, [downloadPackages, spellcheck, spellLanguage]);
  useEffect(() => {
    if (desktop) void api.spellingLanguages().then(setSpellLanguages).catch(() => {});
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 9000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!desktop) return;
    // A discarded effect run (React StrictMode) must not start a second setup.
    let live = true;
    void api
      .settings()
      .then(async (s) => {
        if (!live) return;
        setSettings(s);
        setToolDir(s.toolDirectory ?? "");
        const status = await api.setupStatus(s.toolDirectory);
        if (!live) return;
        const known = {
          ...setupRef.current,
          distribution: status.distribution ?? undefined,
          miktex: status.miktex,
        };
        if (status.complete) updateSetup({ ...known, status: "ready" });
        else if (status.running)
          updateSetup({ ...known, status: "running", runId: null });
        else {
          // First launch: install packages now instead of during the first compile.
          updateSetup({ ...known, status: "needed" });
          setModal("setup");
          void runSetup(s.toolDirectory);
        }
      })
      .catch(notify);
    return () => {
      live = false;
    };
    // Runs once at launch; runSetup reads current state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    void api.onSetup((e) => actions.current.setup(e)).then(keep);
    // Files dragged in from Explorer are copied into the project.
    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (!projectRef.current) return;
        if (payload.type === "enter" || payload.type === "over") setDropping(true);
        else setDropping(false);
        if (payload.type === "drop") void actions.current.drop(payload.paths);
      })
      .then(keep);
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
      // Ctrl+B without Shift belongs to the editor (bold), as in Overleaf.
      const sidebarKey = e.key.toLowerCase() === "b" && e.shiftKey;
      if (
        ["s", "enter", "o", "k", "j"].includes(e.key.toLowerCase()) ||
        sidebarKey ||
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
      if (sidebarKey) {
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
      hint: "Ctrl Shift B",
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
      label: "Settings",
      hint: "",
      run: () => setModal("settings"),
    },
    {
      label: "Set up LaTeX",
      hint: "",
      run: () => {
        setModal("setup");
        void runSetup();
      },
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
  const setupPercent = Math.round(setupProgress(setup) * 100);
  const setupStopped =
    setup.status === "failed" && setup.failure?.problem === "cancelled";
  const openUrl = (url: string) => {
    if (desktop) void openUrlInBrowser(url).catch(notify);
    else window.open(url, "_blank", "noopener,noreferrer");
  };
  return (
    <div className="app-shell">
      <header className={`topbar ${project ? "has-project" : ""}`}>
        <div className="topbar-start">
          {project && (
            <button
              className="icon-button"
              aria-label="Toggle sidebar"
              title="Toggle sidebar · Ctrl Shift B"
              onClick={() => setSidebar((v) => !v)}
            >
              {sidebar ? (
                <PanelLeftClose size={18} />
              ) : (
                <PanelLeftOpen size={18} />
              )}
            </button>
          )}
          <button
            className="brand"
            aria-label="localTEX home"
            title="Home"
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
            {!project && (
              <span className="brand-name">
                local<span className="tex-word">TEX</span>
              </span>
            )}
          </button>
          {project && (
            <>
              <span className="topbar-divider" />
              <span className="project-name" title={project.directory}>
                <FolderOpen size={17} />
                <span>{project.name}</span>
              </span>
              {!desktop && (
                <span className="preview-label">Browser preview</span>
              )}
            </>
          )}
        </div>
        {project && (
          <div className="mode-switch" role="group" aria-label="Workspace layout">
            <button
              className={mode === "write" ? "active" : ""}
              aria-pressed={mode === "write"}
              onClick={() => setMode("write")}
            >
              <Maximize2 size={15} /> Write
            </button>
            <button
              className={mode === "review" ? "active" : ""}
              aria-pressed={mode === "review"}
              onClick={() => setMode("review")}
            >
              <BookOpen size={16} /> Review
            </button>
          </div>
        )}
        <div className="topbar-end">
          {desktop &&
            modal !== "setup" &&
            (setup.status === "running" || setup.status === "failed") && (
              <button
                className={`setup-pill ${setupStopped ? "stopped" : setup.status}`}
                title="Show LaTeX setup"
                onClick={() => setModal("setup")}
              >
                {setup.status === "running" ? (
                  <span
                    className="pill-ring"
                    style={{ "--p": setupPercent / 100 } as React.CSSProperties}
                  />
                ) : (
                  <TriangleAlert size={15} />
                )}
                <span className="pill-label">
                  {setup.status === "running"
                    ? `Setting up LaTeX ${setupPercent}%`
                    : setupStopped
                      ? "Set up LaTeX"
                      : "Finish LaTeX setup"}
                </span>
              </button>
            )}
          {project && (
            <>
              <button
                className="auto-toggle"
                aria-label="Auto compile"
                aria-pressed={autoCompile}
                title="Save and compile after a pause in typing"
                onClick={() => setAutoCompile((value) => !value)}
              >
                <span className="switch" aria-hidden="true" />
                Auto
              </button>
              <button
                className="icon-button"
                title="Save all · Ctrl S"
                aria-label="Save all"
                onClick={() => void saveAll().catch(notify)}
              >
                <Save size={18} />
              </button>
              {buildStatus === "running" ? (
                <div className="compile-group">
                  <button
                    className="button compile-button"
                    onClick={() => void build()}
                  >
                    <Loader2 size={16} className="spin" /> Compiling
                  </button>
                  <button
                    aria-label="Cancel build"
                    title="Cancel build"
                    className="compile-cancel"
                    onClick={() => void cancelBuild()}
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                </div>
              ) : (
                <button
                  className="button compile-button"
                  onClick={() => void build()}
                >
                  <Play size={15} fill="currentColor" /> Compile{" "}
                  <kbd>Ctrl ↵</kbd>
                </button>
              )}
              <span className="topbar-divider" />
            </>
          )}
          <button
            className="icon-button hide-compact"
            aria-label="Command palette"
            title="Command palette · Ctrl K"
            onClick={() => {
              setCommandQuery("");
              setModal("commands");
            }}
          >
            <Command size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Toggle theme"
            title={theme === "light" ? "Use graphite theme" : "Use paper theme"}
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          >
            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <button
            className="icon-button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setModal("settings")}
          >
            <Settings2 size={18} />
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
                  className="button primary large"
                  onClick={() => setModal("new")}
                >
                  <Plus size={19} /> New project
                </button>
                <button
                  className="button secondary large"
                  onClick={() => void openFolder()}
                >
                  <FolderOpen size={19} /> Open folder
                </button>
              </div>
              <span className="welcome-note">
                <ShieldCheck size={16} /> On your machine. On your terms.
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
                <CheckCircle2 size={15} /> Compiled with care
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
                    ? `${settings.recent.length} recent project${settings.recent.length === 1 ? "" : "s"}`
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
                    <ChevronRight size={18} />
                  </button>
                ))
              ) : (
                <div className="first-project">
                  <BookOpen size={26} />
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
                Explore the browser preview <ArrowRight size={15} />
              </button>
            )}
          </div>
          <footer className="welcome-footer">
            <button className="text-button" onClick={() => setModal("help")}>
              Keyboard shortcuts
            </button>
            <span>localTEX 0.1</span>
          </footer>
        </main>
      ) : (
        <>
          {recovery.length > 0 && (
            <div className="recovery-banner">
              <Sparkles size={17} />
              <span>
                We kept your place. {recovery.length} file
                {recovery.length === 1 ? " has" : "s have"} recoverable edits.
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
                  {(
                    [
                      ["files", "Project files", "Files", Files],
                      ["outline", "Document outline", "Outline", ListTree],
                      ["search", "Search project", "Search", Search],
                    ] as const
                  ).map(([id, label, text, Icon]) => (
                    <button
                      key={id}
                      aria-label={label}
                      aria-pressed={sideTab === id}
                      className={sideTab === id ? "active" : ""}
                      onClick={() => setSideTab(id)}
                    >
                      <Icon size={16} />
                      <span>{text}</span>
                    </button>
                  ))}
                </div>
                <div className="sidebar-content">
                  {sideTab === "files" ? (
                    <>
                      <div className="sidebar-heading">
                        <button
                          className="project-root"
                          title={`${project.directory}. Click to add new files at the top level.`}
                          onClick={() => setFolder("")}
                        >
                          {project.name}
                        </button>
                        <span className="heading-actions">
                          <button
                            className="icon-button"
                            aria-label="New file"
                            title={`New file in ${folder || "the project"}`}
                            onClick={() => {
                              setFileName(`${folder ? `${folder}/` : ""}untitled.tex`);
                              setModal("file");
                            }}
                          >
                            <FilePlus2 size={17} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label="New folder"
                            title={`New folder in ${folder || "the project"}`}
                            onClick={() => {
                              setFileName(`${folder ? `${folder}/` : ""}figures`);
                              setModal("folder");
                            }}
                          >
                            <FolderPlus size={17} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label="Add files"
                            title={`Add files to ${folder || "the project"}. You can also drag them in from Explorer.`}
                            onClick={() => void addFiles()}
                          >
                            <Upload size={16} />
                          </button>
                        </span>
                      </div>
                      <FileTree
                        files={project.files}
                        folders={project.folders}
                        active={active}
                        folder={folder}
                        isDirty={(path) =>
                          buffers.current.get(path)?.text !==
                          buffers.current.get(path)?.savedText
                        }
                        onOpen={(path) => void openFile(path)}
                        onSelectFolder={setFolder}
                        onRename={(path) => {
                          setRenaming(path);
                          setFileName(path);
                          setModal("rename");
                        }}
                        onDelete={(path, isFolder) =>
                          void deleteEntry(path, isFolder)
                        }
                      />
                    </>
                  ) : sideTab === "outline" ? (
                    sections.length ? (
                      sections.map((s, i) => (
                        <button
                          key={`${s.path}-${i}`}
                          className={`outline-row level-${Math.max(0, s.level)}`}
                          style={{
                            paddingLeft: 12 + Math.max(0, s.level - 1) * 14,
                          }}
                          onClick={() => void openFile(s.path, s.line)}
                        >
                          <Hash size={13} />
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
                        <Search size={16} />
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
                          {results.length === 200 ? "+" : ""}{" "}
                          {results.length === 1 ? "match" : "matches"}
                        </p>
                      )}
                      {results.map((r, i) => (
                        <button
                          className="search-result"
                          key={i}
                          onClick={() => void openFile(r.path, r.line)}
                        >
                          <strong>
                            {filename(r.path)} <span>line {r.line}</span>
                          </strong>
                          <small>{r.text}</small>
                        </button>
                      ))}
                    </>
                  )}
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
                    <div className="tab-strip">
                      {tabs.map((path) => (
                        <div
                          className={`editor-tab ${path === active ? "active" : ""}`}
                          key={path}
                          title={path}
                        >
                          <button onClick={() => selectActive(path)}>
                            {previewable(path) ? (
                              <Image size={15} className="tree-icon" />
                            ) : (
                              <span
                                className={`file-glyph ${path.endsWith(".bib") ? "bib" : ""}`}
                              >
                                {path.endsWith(".bib") ? "B" : "T"}
                              </span>
                            )}
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
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                      <button
                        className="icon-button tab-plus"
                        aria-label="Create file"
                        title="New file"
                        onClick={() => {
                          setFileName(`${folder ? `${folder}/` : ""}untitled.tex`);
                          setModal("file");
                        }}
                      >
                        <Plus size={17} />
                      </button>
                    </div>
                    <button
                      className="pane-action"
                      aria-label="Jump to PDF"
                      title="Jump to PDF · Ctrl Shift L"
                      disabled={!pdf || !buffer}
                      onClick={() => void syncForward()}
                    >
                      <LocateFixed size={16} />
                      <span>Jump to PDF</span>
                    </button>
                  </div>
                  {buffer && active.endsWith(".tex") && (
                    <EditorToolbar
                      view={() => editor.current}
                      line={currentLine}
                    />
                  )}
                  {buffer?.conflict && (
                    <div className="conflict-banner">
                      <TriangleAlert size={16} />
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
                      <TriangleAlert size={16} />
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
                      spellcheck={spellcheck}
                      spelling={spelling}
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
                  ) : active && previewable(active) ? (
                    <FilePreview projectId={project.id} path={active} />
                  ) : (
                    <div className="empty-state">
                      <FileText size={28} />
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
                <section className="output-panel" aria-label="Build output">
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
                      <X size={16} />
                    </button>
                  </div>
                  {buildStatus === "failed" &&
                    rcFile &&
                    !project.config.latexmkrc && (
                      <div className="missing-banner">
                        <Settings2 size={18} />
                        <span>
                          This project has a <strong>{rcFile}</strong> with
                          build rules localTEX isn’t using yet.
                        </span>
                        <button
                          className="button secondary small"
                          onClick={() => setModal("settings")}
                        >
                          Review in Settings
                        </button>
                      </div>
                    )}
                  {buildStatus === "failed" && missing.length > 0 && (
                    <div className="missing-banner">
                      <Package size={18} />
                      <span>
                        <strong>{missing.join(", ")}</strong>{" "}
                        {missing.length === 1 ? "isn’t" : "aren’t"} installed.
                        {setup.miktex === false &&
                          " Install the package with TeX Live Manager, then compile again."}
                      </span>
                      {setup.miktex !== false && (
                        <button
                          className="button primary small"
                          onClick={() => void build(false, true)}
                        >
                          Install and compile
                        </button>
                      )}
                    </div>
                  )}
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
                            <TriangleAlert size={16} />
                            <span>{issue.message}</span>
                            <small>
                              {issue.path ? filename(issue.path) : ""}
                              {issue.line ? `:${issue.line}` : ""}
                            </small>
                          </button>
                        ))
                      ) : (
                        <div className="no-issues">
                          <CheckCircle2 size={18} />{" "}
                          {buildStatus === "failed"
                            ? "No structured diagnostics found. See compiler output for details."
                            : "No problems reported."}
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
              title="Show build output"
            >
              {buildStatus === "running" ? (
                <Loader2 className="spin" size={14} />
              ) : buildStatus === "success" ? (
                <CheckCircle2 size={14} />
              ) : buildStatus === "failed" ? (
                <TriangleAlert size={14} />
              ) : (
                <Terminal size={14} />
              )}
              <span>
                {buildStatus === "running"
                  ? "Compiling on your machine…"
                  : buildStatus === "success"
                    ? pdfStale
                      ? "Changes since last build"
                      : "PDF is up to date"
                    : buildStatus === "failed"
                      ? "Build failed. See problems"
                      : buildStatus === "cancelled"
                        ? "Build cancelled"
                        : "Not compiled yet"}
              </span>
              <ChevronRight size={13} />
            </button>
            {fetchingPackages && (
              <span className="status-fetch" role="status" aria-live="polite">
                <Loader2 className="spin" size={13} /> Getting packages…
              </span>
            )}
            <span className="status-saved">
              {dirty ? "Unsaved changes" : savedAt}
            </span>
            <span className="status-spacer" />
            {buildOptions.root && (
              <span
                className="status-words"
                title="Words in the document text, including files it inputs. Commands, math and comments are not counted."
              >
                {words.toLocaleString()} {words === 1 ? "word" : "words"}
              </span>
            )}
            <span>
              Ln {cursor.line}, Col {cursor.column}
            </span>
            <span title="Text encoding of this file">
              {buffer?.encoding || "UTF-8"}
            </span>
            <button onClick={() => setModal("settings")} title="LaTeX engine">
              {engineNames[buildOptions.engine]} <ChevronDown size={13} />
            </button>
            <span className="status-local">
              <span /> Local
            </span>
          </footer>
        </>
      )}
      {dropping && project && (
        <div className="drop-overlay" aria-hidden="true">
          <Upload size={28} />
          <strong>Drop to add files to {folder || project.name}</strong>
          <span>They are copied into the project folder.</span>
        </div>
      )}
      {busy && (
        <div className="busy-indicator" role="status">
          <Loader2 size={17} className="spin" /> Opening your workspace…
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <CircleHelp size={19} />
          <span>{notice}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal === "setup" && (
        <SetupDialog
          view={setup}
          onClose={() => setModal(null)}
          onStart={() => void runSetup()}
          onStop={() => void stopSetup()}
          onOpenUrl={openUrl}
          onChooseFolder={() => setModal("settings")}
        />
      )}
      {modal === "new" && (
        <Modal title="New project" onClose={() => setModal(null)}>
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
                <FileText size={26} />
                <strong>Research article</strong>
                <span>A clear, considered beginning.</span>
                {template === "article" && <Check size={17} />}
              </button>
              <button
                type="button"
                className={template === "thesis" ? "selected" : ""}
                onClick={() => setTemplate("thesis")}
              >
                <BookOpen size={26} />
                <strong>Thesis</strong>
                <span>A home for the bigger picture.</span>
                {template === "thesis" && <Check size={17} />}
              </button>
            </div>
            <div className="modal-footer">
              <span>
                <ShieldCheck size={15} /> Saved as ordinary local files
              </span>
              <button className="button primary" disabled={busy} type="submit">
                {desktop ? "Choose location" : "Explore sample"}
                <ArrowRight size={17} />
              </button>
            </div>
          </form>
        </Modal>
      )}
      {(modal === "file" || modal === "rename" || modal === "folder") && (
        <Modal
          title={
            modal === "rename"
              ? `Rename ${project?.folders.includes(renaming) ? "folder" : "file"}`
              : modal === "folder"
                ? "New folder"
                : "New file"
          }
          onClose={() => setModal(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void createOrRename();
            }}
          >
            <p className="modal-intro">
              {modal === "rename"
                ? "Include a folder to move it, for example chapters/intro.tex. Renaming doesn’t update \\input, \\include or \\includegraphics references."
                : "Use a path inside this project, for example chapters/intro.tex."}
            </p>
            <label className="field-label">
              {modal === "folder" ? "Folder name" : "Name"}
              <input
                autoFocus
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                onFocus={(e) => {
                  // Select just the name, keeping the folder part, as Explorer does.
                  const value = e.target.value;
                  const start = value.lastIndexOf("/") + 1;
                  const dot = value.lastIndexOf(".");
                  e.target.setSelectionRange(
                    start,
                    dot > start && modal !== "folder" ? dot : value.length,
                  );
                }}
                required
              />
            </label>
            <div className="modal-footer">
              <span />
              <button className="button primary" type="submit">
                {modal === "rename"
                  ? "Rename"
                  : modal === "folder"
                    ? "Create folder"
                    : "Create file"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "settings" && (
        <Modal title="Settings" wide onClose={() => setModal(null)}>
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
                    <Sun size={16} /> Paper
                  </button>
                  <button
                    className={theme === "dark" ? "active" : ""}
                    onClick={() => setTheme("dark")}
                  >
                    <Moon size={16} /> Graphite
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
              <label className="setting-row">
                <div>
                  <strong>Check spelling</strong>
                  <p>
                    Underlines misspelled words in your text, not in commands,
                    math or labels. Uses the languages installed in Windows;
                    right-click a word for suggestions.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={spellcheck}
                  onChange={(e) => setSpellcheck(e.target.checked)}
                />
              </label>
              {spellcheck && spellLanguages.length > 0 && (
                <label className="field-label horizontal">
                  <span>Spelling language</span>
                  <select
                    value={language}
                    onChange={(e) => setSpellLanguage(e.target.value)}
                  >
                    {spellLanguages.map((tag) => (
                      <option key={tag} value={tag}>
                        {languageName(tag)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
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
                    <option value="">Auto ({engineNames[autoEngine]})</option>
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
                {rcFile && (
                  <label className="setting-row">
                    <div>
                      <strong>Use this project’s {rcFile}</strong>
                      <p>
                        Applies its build rules, for example for a glossary or
                        nomenclature. A latexmkrc can run any program on your
                        computer, so turn this on only for projects you trust.
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={project.config.latexmkrc}
                      onChange={(e) => {
                        if (!e.target.checked)
                          void saveConfig({ latexmkrc: false });
                        else
                          void ask(
                            `Use ${rcFile} for this trusted project? It can run programs on your computer.`,
                          ).then((ok) => {
                            if (ok) void saveConfig({ latexmkrc: true });
                          });
                      }}
                    />
                  </label>
                )}
              </section>
            )}
            <section>
              <h3>LaTeX</h3>
              <div className={`setup-summary ${setup.status}`}>
                <span className="setup-dot" aria-hidden="true" />
                <div>
                  <strong>
                    {!desktop
                      ? "Available in the desktop app"
                      : setup.status === "ready"
                        ? `${setup.distribution ?? "LaTeX"} is set up`
                        : setup.status === "running"
                          ? "Setup is running"
                          : setup.status === "failed" && !setupStopped
                            ? "Setup needs attention"
                            : "Not set up yet"}
                  </strong>
                  <p>
                    {!desktop
                      ? "The browser preview doesn’t compile LaTeX."
                      : setup.status === "ready"
                        ? "Common packages are installed. Run setup again after changing your LaTeX installation."
                        : setup.status === "running"
                          ? `${setupPercent}% done. You can keep working while it finishes.`
                          : setup.status === "failed" && setup.failure && !setupStopped
                            ? firstLine(setup.failure.text)
                            : "Installs the packages most papers use, so compiling starts right away."}
                  </p>
                </div>
                <button
                  className="button secondary"
                  disabled={!desktop}
                  onClick={() => {
                    setModal("setup");
                    if (setup.status !== "running") void runSetup();
                  }}
                >
                  {setup.status === "running"
                    ? "Show progress"
                    : setup.status === "ready"
                      ? "Run setup again"
                      : "Set up LaTeX"}
                </button>
              </div>
              <label className="setting-row">
                <div>
                  <strong>Download missing packages automatically</strong>
                  <p>
                    When a document loads a package that isn’t installed,
                    MiKTeX downloads it in the background as soon as you open
                    or save the file, before you compile. Builds can also
                    fetch anything still missing. When this is off, localTEX
                    asks first.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={downloadPackages}
                  onChange={(e) => setDownloadPackages(e.target.checked)}
                />
              </label>
              <label className="field-label">
                LaTeX folder{" "}
                <span className="optional">
                  Optional. Leave empty to use the folders on your PATH.
                </span>
                <div className="input-with-button">
                  <input
                    value={toolDir}
                    onChange={(e) => setToolDir(e.target.value)}
                    placeholder="e.g. C:\Program Files\MiKTeX\miktex\bin\x64"
                  />
                  <button
                    className="icon-button"
                    aria-label="Choose LaTeX folder"
                    disabled={!desktop}
                    onClick={() =>
                      void open({ directory: true, multiple: false }).then(
                        (p) => {
                          if (typeof p === "string") setToolDir(p);
                        },
                      )
                    }
                  >
                    <FolderOpen size={17} />
                  </button>
                </div>
              </label>
              <div className="setup-actions">
                <button
                  className="button secondary"
                  disabled={!desktop || checking}
                  onClick={() => void checkTools()}
                >
                  {checking ? (
                    <Loader2 size={16} className="spin" />
                  ) : (
                    <CheckCircle2 size={16} />
                  )}
                  Save and check tools
                </button>
                <button
                  className="button secondary"
                  disabled={!desktop || checking}
                  onClick={() => void testBuild()}
                >
                  <Play size={15} /> Test compilation
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
                    <details key={t.name} className={t.available ? "ready" : "missing"}>
                      <summary>
                        {t.available ? (
                          <CheckCircle2 size={16} />
                        ) : (
                          <TriangleAlert size={16} />
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
                    onClick={() => openUrl(url)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </section>
            <div className="privacy-note">
              <ShieldCheck size={20} />
              <div>
                <strong>Your work stays yours.</strong>
                <p>
                  No accounts, analytics, or cloud compilation. Fonts and PDF
                  rendering are bundled. localTEX goes online only to
                  download LaTeX packages: during setup, and when a document
                  needs one that isn’t installed (you can turn that off above).
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
            <Search size={20} />
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
                  {c.hint && <kbd>{c.hint}</kbd>}
                </button>
              ))}
          </div>
        </Modal>
      )}
      {modal === "help" && (
        <Modal title="Keyboard shortcuts" onClose={() => setModal(null)}>
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
              ["Show / hide sidebar", "Ctrl Shift B"],
              ["Bold / italic", "Ctrl B / Ctrl I"],
              ["Comment lines", "Ctrl /"],
              ["Fold / unfold section", "Ctrl Shift [ / ]"],
              ["Add cursor", "Ctrl click"],
              ["Select next match", "Ctrl D"],
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
            localTEX 0.1. Built for a slower breath and a sharper thought.
          </p>
        </Modal>
      )}
    </div>
  );
}

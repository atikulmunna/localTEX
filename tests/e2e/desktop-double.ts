import type { Page } from "@playwright/test";

// Replaces Tauri's IPC with an in-page double, so desktop flows run in the browser.
// These are frontend integration checks; they do not claim native execution.
export async function installDesktopDouble(
  page: Page,
  options: {
    setupComplete?: boolean;
    latexmkrc?: boolean;
    text?: string;
    encoding?: string;
    engine?: string | null;
    /** Files that start with \documentclass; given, no root is configured. */
    roots?: string[];
  } = {},
) {
  await page.addInitScript((options) => {
    const w = window as any;
    w.isTauri = true;
    const callbacks = new Map<number, Function>();
    const listeners = new Map<string, number>();
    let next = 1;
    const document = {
      path: "main.tex",
      text:
        options.text ??
        "\\documentclass{article}\n\\begin{document}Hello\\end{document}",
      revision: "1",
      encoding: options.encoding ?? "UTF-8",
    };
    const project = {
      id: "test",
      name: "Auto test",
      directory: "D:/Auto test",
      roots: options.roots ?? ["main.tex"],
      folders: ["figures"],
      files: [
        { path: "figures/plot.png", size: 68, editable: false },
        ...(options.latexmkrc
          ? [{ path: "latexmkrc", size: 40, editable: true }]
          : []),
        ...(options.roots ?? ["main.tex"]).map((path) => ({
          path,
          size: 80,
          editable: true,
        })),
      ],
      config: {
        version: 1,
        root: options.roots ? null : "main.tex",
        engine: options.engine === undefined ? "pdflatex" : options.engine,
        shellEscape: false,
        latexmkrc: false,
      },
    };
    w.testIPC = {
      calls: [],
      builds: [],
      setups: [],
      configs: [],
      fileOps: [],
      spellChecks: [],
      fetches: [],
      holdFetch: false,
      releaseFetch: () => {},
      conflict: false,
      setupStatus: {
        complete: options.setupComplete ?? true,
        running: false,
        distribution: "MiKTeX 26.5",
        miktex: true,
      },
      emit(event: string, payload: unknown) {
        callbacks.get(listeners.get(event)!)?.({ payload });
      },
      output(text: string) {
        const build = this.builds.at(-1);
        this.emit("build-event", {
          projectId: "test",
          buildId: build.buildId,
          kind: "output",
          success: false,
          text,
        });
      },
      /** Ends the build; `pdf` means LaTeX wrote one, possibly despite errors. */
      finish(pdf = false) {
        const build = this.builds.at(-1);
        this.emit("build-event", {
          projectId: "test",
          buildId: build.buildId,
          kind: "finished",
          success: pdf,
          text: pdf ? "PDF updated. LaTeX reported errors." : "Build failed",
        });
      },
      setup(event: object) {
        this.emit("setup-event", { runId: this.setups.at(-1).runId, ...event });
      },
    };
    w.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback(callback: Function) {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      async invoke(command: string, args: any) {
        w.testIPC.calls.push(command);
        if (command === "load_settings")
          return { recent: ["D:/Auto test"], toolDirectory: null };
        if (command === "plugin:event|listen") {
          listeners.set(args.event, args.handler);
          return next++;
        }
        if (command === "setup_status") return w.testIPC.setupStatus;
        // The dialog plugin's confirm() asks with a message and returns the clicked label.
        if (command === "plugin:dialog|message") return "Ok";
        if (command === "save_project_config") {
          w.testIPC.configs.push(args.config);
          return;
        }
        if (command === "start_setup") {
          w.testIPC.setups.push(args);
          return;
        }
        if (command === "open_project" || command === "refresh_project")
          return project;
        if (command === "index_project") return [{ ...document }];
        if (command === "load_drafts") return [];
        if (command === "read_file") return { ...document, path: args.path };
        if (command === "save_file") {
          if (w.testIPC.conflict)
            throw new Error("CONFLICT: external file changed");
          Object.assign(document, args.document, {
            revision: String(Number(document.revision) + 1),
          });
          return document.revision;
        }
        if (command === "start_build")
          w.testIPC.builds.push({ ...args, text: document.text });
        if (
          ["create_folder", "delete_entry", "import_files"].includes(command)
        ) {
          w.testIPC.fileOps.push({ command, ...args });
          return command === "import_files"
            ? args.sources.map((s: string) => `${args.folder}/${s.split("/").at(-1)}`)
            : undefined;
        }
        if (command === "plugin:dialog|open") return ["C:/Pictures/chart.png"];
        if (command === "plugin:dialog|save") return "C:/Exports/paper.pdf";
        if (command === "export_pdf") {
          w.testIPC.fileOps.push({ command, ...args });
          return;
        }
        // A spell checker that knows one misspelling, "teh".
        if (command === "spelling_languages") return ["en-US", "bn-BD"];
        if (command === "check_spelling") {
          w.testIPC.spellChecks.push(args);
          return [...args.text.matchAll(/\bteh\b/g)].map((m: RegExpMatchArray) => ({
            from: m.index,
            to: m.index! + 3,
          }));
        }
        if (command === "spelling_suggestions") return ["the", "ten"];
        // MiKTeX lacks algorithm2e (it downloads) and nosuchpkg (a typo, it fails).
        if (command === "fetch_packages") {
          w.testIPC.fetches.push(args);
          const result = {
            supported: true,
            installed: args.files.filter((f: string) => f.startsWith("algorithm2e")),
            failed: args.files.filter((f: string) => f.startsWith("nosuchpkg")),
          };
          if (!w.testIPC.holdFetch) return result;
          return new Promise((resolve) => {
            w.testIPC.releaseFetch = () => resolve(result);
          });
        }
        if (command === "add_to_dictionary") {
          w.testIPC.fileOps.push({ command, ...args });
          return;
        }
        if (command === "read_binary") {
          // A real 1 x 1 PNG, so the preview's <img> can load it.
          const png = atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          );
          return Uint8Array.from(png, (c) => c.charCodeAt(0)).buffer;
        }
      },
    };
  }, options);
}

/** What the frontend has asked the desktop double to do so far. */
export const recorded = (page: Page) =>
  page.evaluate(() => {
    const t = (window as any).testIPC;
    return {
      calls: t.calls as string[],
      builds: t.builds as Record<string, any>[],
      setups: t.setups as Record<string, any>[],
      configs: t.configs as Record<string, any>[],
      fileOps: t.fileOps as Record<string, any>[],
      spellChecks: t.spellChecks as { language: string; text: string }[],
      fetches: t.fetches as { engine: string; files: string[] }[],
    };
  });

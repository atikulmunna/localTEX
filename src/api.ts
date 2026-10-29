import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BuildEvent,
  DocumentFile,
  Draft,
  Engine,
  Project,
  ProjectConfig,
  Settings,
  ToolStatus,
} from "./types";
export const desktop = isTauri();
export const api = {
  settings: () => invoke<Settings>("load_settings"),
  saveSettings: (settings: Settings) =>
    invoke<void>("save_settings", { settings }),
  open: (directory: string) => invoke<Project>("open_project", { directory }),
  refresh: (projectId: string) =>
    invoke<Project>("refresh_project", { projectId }),
  read: (projectId: string, path: string) =>
    invoke<DocumentFile>("read_file", { projectId, path }),
  save: (projectId: string, document: DocumentFile) =>
    invoke<string>("save_file", { projectId, document }),
  createFile: (projectId: string, path: string) =>
    invoke<void>("create_file", { projectId, path }),
  rename: (projectId: string, from: string, to: string) =>
    invoke<void>("rename_file", { projectId, from, to }),
  config: (projectId: string, config: ProjectConfig) =>
    invoke<void>("save_project_config", { projectId, config }),
  create: (parent: string, name: string, template: string) =>
    invoke<string>("create_project", { parent, name, template }),
  index: (projectId: string) =>
    invoke<DocumentFile[]>("index_project", { projectId }),
  draft: (draft: Draft) => invoke<void>("save_draft", { draft }),
  drafts: (project: string) => invoke<Draft[]>("load_drafts", { project }),
  removeDraft: (project: string, path: string) =>
    invoke<void>("remove_draft", { project, path }),
  tools: (directory: string | null) =>
    invoke<ToolStatus[]>("check_toolchain", { directory }),
  preparePackages: (directory: string | null) =>
    invoke<string>("prepare_packages", { directory }),
  test: (directory: string | null, engine: Engine) =>
    invoke<string>("test_compilation", { directory, engine }),
  build: (
    projectId: string,
    buildId: string,
    document: string,
    engine: Engine,
    directory: string | null,
    force: boolean,
  ) =>
    invoke<void>("start_build", {
      projectId,
      buildId,
      document,
      engine,
      directory,
      force,
    }),
  cancel: (projectId: string) => invoke<void>("cancel_build", { projectId }),
  pdf: async (projectId: string) =>
    new Uint8Array(await invoke<ArrayBuffer>("read_pdf", { projectId })),
  export: (projectId: string, destination: string) =>
    invoke<void>("export_pdf", { projectId, destination }),
  sync: (args: {
    projectId: string;
    directory: string | null;
    document: string;
    source?: string;
    line?: number;
    page?: number;
    x?: number;
    y?: number;
  }) => invoke<string>("synctex", args),
  onBuild: (handler: (event: BuildEvent) => void) =>
    listen<BuildEvent>("build-event", (e) => handler(e.payload)),
  onFiles: (handler: (event: { projectId: string; paths: string[] }) => void) =>
    listen<{ projectId: string; paths: string[] }>("files-changed", (e) =>
      handler(e.payload),
    ),
};

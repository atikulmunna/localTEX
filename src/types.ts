export type Engine = "pdflatex" | "xelatex" | "lualatex";
export interface ProjectConfig {
  version: number;
  root: string | null;
  engine: Engine | null;
  shellEscape: boolean;
}
export interface ProjectFile {
  path: string;
  size: number;
  editable: boolean;
}
export interface Project {
  id: string;
  name: string;
  directory: string;
  files: ProjectFile[];
  roots: string[];
  config: ProjectConfig;
}
export interface DocumentFile {
  path: string;
  text: string;
  revision: string;
}
export interface BufferFile extends DocumentFile {
  savedText: string;
  conflict?: DocumentFile;
  missing?: boolean;
}
export interface Draft extends DocumentFile {
  project: string;
}
export interface Settings {
  recent: string[];
  toolDirectory: string | null;
}
export interface ToolStatus {
  name: string;
  available: boolean;
  detail: string;
}
export type SetupStep = "tools" | "packages" | "verify";
export type SetupProblem =
  | "missing-tex"
  | "missing-latexmk"
  | "missing-perl"
  | "package-manager"
  | "download"
  | "sample"
  | "cancelled";
export interface SetupOutcome {
  distribution: string;
  miktex: boolean;
  installed: string[];
}
export interface SetupFailure {
  step: SetupStep;
  problem: SetupProblem;
  text: string;
}
export type SetupEvent = { runId: string } & (
  | {
      kind: "step";
      step: SetupStep;
      state: "running" | "done" | "skipped";
      text: string;
    }
  | {
      kind: "progress";
      step: SetupStep;
      done: number;
      total: number;
      text: string;
    }
  | { kind: "line"; text: string }
  | { kind: "finished"; success: true; outcome: SetupOutcome }
  | { kind: "finished"; success: false; failure: SetupFailure }
);
export interface SetupStatus {
  complete: boolean;
  running: boolean;
  distribution: string | null;
  miktex: boolean | null;
}
export interface BuildEvent {
  projectId: string;
  buildId: string;
  kind: "started" | "output" | "finished";
  text: string;
  success: boolean;
}
export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  path?: string;
  line?: number;
}
export interface OutlineItem {
  title: string;
  line: number;
  level: number;
  path: string;
}
export interface SearchResult {
  path: string;
  line: number;
  text: string;
}
export interface SyncPoint {
  page: number;
  x: number;
  y: number;
}

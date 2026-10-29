import type { SetupEvent, SetupFailure, SetupStep } from "./types.ts";

export type StepState = "pending" | "running" | "done" | "skipped" | "failed";
export interface StepView {
  state: StepState;
  text: string;
  done?: number;
  total?: number;
}
export interface SetupView {
  runId: string | null;
  status: "unknown" | "needed" | "running" | "ready" | "failed";
  steps: Record<SetupStep, StepView>;
  lines: string[];
  failure?: SetupFailure;
  distribution?: string;
  miktex: boolean | null;
  installed: string[];
}

export const setupSteps: { id: SetupStep; title: string; waiting: string }[] =
  [
    {
      id: "tools",
      title: "Find LaTeX",
      waiting: "Checks for MiKTeX or TeX Live, and latexmk",
    },
    {
      id: "packages",
      title: "Install common packages",
      waiting: "Maths, figures, tables, citations, diagrams and fonts",
    },
    {
      id: "verify",
      title: "Compile a test document",
      waiting: "Fetches the supporting files those packages load",
    },
  ];
// Package downloads dominate the wait, so they dominate the overall bar.
const weights: Record<SetupStep, number> = {
  tools: 0.1,
  packages: 0.6,
  verify: 0.3,
};
const lineLimit = 400;

function waitingSteps(): Record<SetupStep, StepView> {
  return Object.fromEntries(
    setupSteps.map((s) => [s.id, { state: "pending", text: s.waiting }]),
  ) as Record<SetupStep, StepView>;
}
export function idleSetup(): SetupView {
  return {
    runId: null,
    status: "unknown",
    steps: waitingSteps(),
    lines: [],
    miktex: null,
    installed: [],
  };
}
export function beginSetup(view: SetupView, runId: string): SetupView {
  return {
    ...view,
    runId,
    status: "running",
    steps: waitingSteps(),
    lines: [],
    failure: undefined,
    installed: [],
  };
}
export const firstLine = (text: string) => text.split("\n")[0].trim();

export function applySetupEvent(view: SetupView, event: SetupEvent): SetupView {
  if (event.runId !== view.runId) return view;
  switch (event.kind) {
    case "step":
      return {
        ...view,
        steps: {
          ...view.steps,
          [event.step]: { state: event.state, text: event.text },
        },
      };
    case "progress":
      return {
        ...view,
        steps: {
          ...view.steps,
          [event.step]: {
            state: "running",
            text: event.text,
            done: event.done,
            total: event.total,
          },
        },
      };
    case "line":
      return {
        ...view,
        lines: [...view.lines.slice(-(lineLimit - 1)), event.text],
      };
    case "finished":
      return event.success
        ? {
            ...view,
            status: "ready",
            distribution: event.outcome.distribution,
            miktex: event.outcome.miktex,
            installed: event.outcome.installed,
          }
        : {
            ...view,
            status: "failed",
            failure: event.failure,
            steps: {
              ...view.steps,
              [event.failure.step]: {
                state: "failed",
                text: firstLine(event.failure.text),
              },
            },
          };
  }
}

/** Overall completion from 0 to 1. */
export function setupProgress(view: SetupView): number {
  if (view.status === "ready") return 1;
  let total = 0;
  for (const { id } of setupSteps) {
    const step = view.steps[id];
    if (step.state === "done" || step.state === "skipped") total += weights[id];
    else if (step.state === "running")
      total +=
        weights[id] *
        (step.total ? Math.min(1, (step.done ?? 0) / step.total) : 0.1);
  }
  return Math.min(1, total);
}

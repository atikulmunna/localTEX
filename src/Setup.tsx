import {
  Check,
  Download,
  Loader2,
  Minus,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { Modal } from "./Modal";
import { firstLine, setupProgress, setupSteps, type SetupView } from "./setupState";

const downloads = {
  miktex: "https://miktex.org/download",
  perl: "https://strawberryperl.com/",
};

interface Props {
  view: SetupView;
  onClose: () => void;
  onStart: () => void;
  onStop: () => void;
  onOpenUrl: (url: string) => void;
  onChooseFolder: () => void;
}
export function SetupDialog({
  view,
  onClose,
  onStart,
  onStop,
  onOpenUrl,
  onChooseFolder,
}: Props) {
  const percent = Math.round(setupProgress(view) * 100);
  const running = view.status === "running";
  const failure = view.status === "failed" ? view.failure : undefined;
  const stopped = failure?.problem === "cancelled";
  const details = failure?.text.split("\n").slice(1).join("\n").trim();
  const title =
    view.status === "ready"
      ? "LaTeX is ready"
      : failure && !stopped
        ? "LaTeX setup needs attention"
        : "Set up LaTeX";
  return (
    <Modal title={title} onClose={onClose} className="setup-modal">
      <div className="setup-body">
        <p className="setup-intro">
          {view.status === "ready"
            ? `${view.distribution ?? "LaTeX"} is set up. ${
                view.installed.length
                  ? `Installed ${view.installed.length} package${view.installed.length === 1 ? "" : "s"}.`
                  : "Every common package was already installed."
              } Compiling now starts right away.`
            : "localTEX installs the packages most papers use, so your first compile is quick. This runs once and can take a few minutes. Packages download from MiKTeX’s servers."}
        </p>
        <div
          className={`setup-meter ${view.status}`}
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <ol className="setup-steps">
          {setupSteps.map((step, index) => {
            const state = view.steps[step.id];
            const fraction = state.total
              ? Math.min(1, (state.done ?? 0) / state.total)
              : 0;
            return (
              <li key={step.id} className={`setup-step ${state.state}`}>
                <span className="setup-step-mark" aria-hidden="true">
                  {state.state === "running" ? (
                    <Loader2 size={16} className="spin" />
                  ) : state.state === "done" ? (
                    <Check size={16} strokeWidth={2.5} />
                  ) : state.state === "skipped" ? (
                    <Minus size={16} />
                  ) : state.state === "failed" ? (
                    <TriangleAlert size={16} />
                  ) : (
                    index + 1
                  )}
                </span>
                <div className="setup-step-text">
                  <strong>{step.title}</strong>
                  <span>
                    {/* The problem panel below carries the full message. */}
                    {state.state === "failed" && failure && !stopped
                      ? "This step didn’t finish."
                      : state.text}
                  </span>
                  {state.state === "running" && state.total ? (
                    <div className="setup-step-progress">
                      <div className="step-meter">
                        <span style={{ width: `${fraction * 100}%` }} />
                      </div>
                      <small>
                        {Math.min(state.done ?? 0, state.total)} of{" "}
                        {state.total}
                      </small>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        {failure && !stopped && (
          <div className="setup-problem" role="alert">
            <TriangleAlert size={18} />
            <div>
              <strong>{firstLine(failure.text)}</strong>
              {details && <pre>{details}</pre>}
            </div>
          </div>
        )}
        {view.lines.length > 0 && (
          <details className="setup-log">
            <summary>Show details</summary>
            <pre>{view.lines.join("\n")}</pre>
          </details>
        )}
      </div>
      <div className="setup-footer">
        <div className="setup-footer-note">
          {running ? (
            `${percent}% done`
          ) : failure?.problem === "missing-tex" ? (
            <button className="text-button" onClick={onChooseFolder}>
              LaTeX is installed somewhere else? Choose its folder
            </button>
          ) : null}
        </div>
        <div className="setup-footer-actions">
          {running ? (
            <>
              <button className="button secondary" onClick={onStop}>
                Stop setup
              </button>
              <button className="button primary" onClick={onClose}>
                Continue in background
              </button>
            </>
          ) : view.status === "ready" ? (
            <button className="button primary" onClick={onClose}>
              Start writing
            </button>
          ) : (
            <>
              {failure?.problem === "missing-tex" ||
              failure?.problem === "missing-perl" ? (
                <button
                  className="button secondary"
                  onClick={() =>
                    onOpenUrl(
                      failure.problem === "missing-tex"
                        ? downloads.miktex
                        : downloads.perl,
                    )
                  }
                >
                  <Download size={16} />
                  {failure.problem === "missing-tex"
                    ? "Download MiKTeX"
                    : "Download Strawberry Perl"}
                </button>
              ) : (
                <button className="button secondary" onClick={onClose}>
                  Not now
                </button>
              )}
              <button className="button primary" onClick={onStart}>
                <RotateCw size={16} />
                {failure && !stopped
                  ? failure.problem.startsWith("missing")
                    ? "Check again"
                    : "Try again"
                  : "Start setup"}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

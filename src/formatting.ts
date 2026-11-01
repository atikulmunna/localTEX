import { EditorSelection } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { snippet, startCompletion } from "@codemirror/autocomplete";

/**
 * Wraps each selection in `open`...`close`, or unwraps it if it is already wrapped,
 * as Overleaf's Bold and Italic do. An empty selection leaves the cursor inside.
 */
export function toggleWrap(open: string, close = "}"): Command {
  return (view) => {
    const { state } = view;
    view.dispatch(
      state.changeByRange((range) => {
        const wrapped =
          state.sliceDoc(range.from - open.length, range.from) === open &&
          state.sliceDoc(range.to, range.to + close.length) === close;
        return wrapped
          ? {
              changes: [
                { from: range.from - open.length, to: range.from },
                { from: range.to, to: range.to + close.length },
              ],
              range: EditorSelection.range(
                range.from - open.length,
                range.to - open.length,
              ),
            }
          : {
              changes: [
                { from: range.from, insert: open },
                { from: range.to, insert: close },
              ],
              range: EditorSelection.range(
                range.from + open.length,
                range.to + open.length,
              ),
            };
      }),
      { scrollIntoView: true, userEvent: "input" },
    );
    return true;
  };
}

export const headingLevels = [
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
] as const;
export type HeadingLevel = (typeof headingLevels)[number];
const headingLine =
  /^(\s*)\\(chapter|section|subsection|subsubsection|paragraph)\*?\{(.*)\}\s*$/;
/** The heading level of a source line, or null for ordinary text. */
export function headingOf(line: string): HeadingLevel | null {
  return (line.match(headingLine)?.[2] as HeadingLevel | undefined) ?? null;
}
/** Turns the cursor's line into a heading of `level`, or back into text with null. */
export function setHeading(view: EditorView, level: HeadingLevel | null) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const match = line.text.match(headingLine);
  const indent = match?.[1] ?? line.text.match(/^\s*/)![0];
  const title = match ? match[3] : line.text.trim();
  const insert = level ? `${indent}\\${level}{${title}}` : `${indent}${title}`;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: line.from + insert.length - (level ? 1 : 0) },
    scrollIntoView: true,
    userEvent: "input",
  });
}

/** Makes the selected lines items of a list, or starts a list on an empty line. */
export function makeList(view: EditorView, environment: "itemize" | "enumerate") {
  const { state } = view;
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);
  const indent = first.text.match(/^\s*/)![0];
  const items: string[] = [];
  for (let n = first.number; n <= last.number; n++) {
    const text = state.doc
      .line(n)
      .text.trim()
      .replace(/^\\item\s*/, "");
    if (text || n === first.number) items.push(`${indent}  \\item ${text}`);
  }
  const head = `${indent}\\begin{${environment}}\n`;
  const insert = `${head}${items.join("\n")}\n${indent}\\end{${environment}}`;
  view.dispatch({
    changes: { from: first.from, to: last.to, insert },
    // The cursor goes to the end of the first item, ready to type.
    selection: { anchor: first.from + head.length + items[0].length },
    scrollIntoView: true,
    userEvent: "input",
  });
}

/** Display math around the selection, on lines of its own. */
export function displayMath(view: EditorView) {
  const { state } = view;
  const range = state.selection.main;
  const text = state.sliceDoc(range.from, range.to);
  const insert = `\\[\n  ${text}\n\\]`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + 5 + text.length },
    scrollIntoView: true,
    userEvent: "input",
  });
}

/** A link: the selection becomes its text, and the cursor waits for the address. */
export function link(view: EditorView) {
  const range = view.state.selection.main;
  const text = view.state.sliceDoc(range.from, range.to);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `\\href{}{${text}}` },
    selection: { anchor: range.from + "\\href{".length },
    userEvent: "input",
  });
}

/** \ref{} or \cite{}, with the list of labels or bibliography keys opened. */
export function reference(view: EditorView, command: "ref" | "cite") {
  const range = view.state.selection.main;
  const insert = `\\${command}{}`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length - 1 },
    userEvent: "input",
  });
  startCompletion(view);
}

const templates = {
  figure:
    "\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${file}}\n  \\caption{${caption}}\n  \\label{fig:${label}}\n\\end{figure}",
  table:
    "\\begin{table}[htbp]\n  \\centering\n  \\begin{tabular}{${ll}}\n    ${Heading} & ${Heading} \\\\\n    \\hline\n    ${Cell} & ${Cell} \\\\\n  \\end{tabular}\n  \\caption{${caption}}\n  \\label{tab:${label}}\n\\end{table}",
};
/** A figure or table on its own lines; Tab moves between the parts to fill in. */
export function insertBlock(view: EditorView, kind: keyof typeof templates) {
  const range = view.state.selection.main;
  const line = view.state.doc.lineAt(range.from);
  const before = view.state.sliceDoc(line.from, range.from).trim() ? "\n" : "";
  snippet(before + templates[kind])(view, null, range.from, range.to);
}

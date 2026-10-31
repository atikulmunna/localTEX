import { useEffect, useRef } from "react";
import {
  EditorState,
  Compartment,
  EditorSelection,
  Prec,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  crosshairCursor,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  type Command,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldKeymap,
  foldService,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
} from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { tags } from '@lezer/highlight';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import type { Diagnostic, DocumentFile } from "./types";
import { foldEnd, nonProse, projectSymbols } from "./core";

const states = new Map<string, EditorState>();
const scrollPositions = new Map<string, number>();
// Compartments must have stable identity across editor unmounts and restored states.
const completion = new Compartment();
const updates = new Compartment();
const spelling = new Compartment();

const latexFolding = foldService.of((state, from) => {
  const start = state.doc.lineAt(from);
  const end = foldEnd(
    (n) => state.doc.line(n).text,
    state.doc.lines,
    start.number,
  );
  return end ? { from: start.to, to: state.doc.line(end.line).from + end.column } : null;
});

/** Ctrl+B and Ctrl+I, as in Overleaf: wrap each selection, or unwrap it if already wrapped. */
function wrapWith(command: string): Command {
  const open = `\\${command}{`;
  return (view) => {
    const { state } = view;
    view.dispatch(
      state.changeByRange((range) => {
        const wrapped =
          state.sliceDoc(range.from - open.length, range.from) === open &&
          state.sliceDoc(range.to, range.to + 1) === "}";
        return wrapped
          ? {
              changes: [
                { from: range.from - open.length, to: range.from },
                { from: range.to, to: range.to + 1 },
              ],
              range: EditorSelection.range(
                range.from - open.length,
                range.to - open.length,
              ),
            }
          : {
              changes: [
                { from: range.from, insert: open },
                { from: range.to, insert: "}" },
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

// The system spell checker (Windows, through WebView2) checks the editor's text. LaTeX
// commands, math, labels and paths are marked so it underlines only prose.
const notProse = Decoration.mark({ attributes: { spellcheck: "false" } });
// Very large files are scanned around the visible lines only, to keep typing fast.
const wholeScanLimit = 1_000_000;
function scan(view: EditorView): [number, number][] {
  const { doc } = view.state;
  if (doc.length <= wholeScanLimit) return nonProse(doc.toString());
  return view.visibleRanges.flatMap(({ from, to }) => {
    const start = doc.lineAt(from).from;
    return nonProse(doc.sliceString(start, doc.lineAt(to).to)).map(
      ([a, b]): [number, number] => [start + a, start + b],
    );
  });
}
function proseMarks(view: EditorView, ranges: [number, number][]) {
  const builder = new RangeSetBuilder<Decoration>();
  const visible = view.visibleRanges;
  for (const [from, to] of ranges)
    if (visible.some((range) => from < range.to && to > range.from))
      builder.add(from, to, notProse);
  return builder.finish();
}
const spellChecking = [
  EditorView.contentAttributes.of({ spellcheck: "true" }),
  ViewPlugin.fromClass(
    class {
      ranges: [number, number][];
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.ranges = scan(view);
        this.decorations = proseMarks(view, this.ranges);
      }
      update(update: ViewUpdate) {
        const large = update.state.doc.length > wholeScanLimit;
        if (update.docChanged || (large && update.viewportChanged))
          this.ranges = scan(update.view);
        if (update.docChanged || update.viewportChanged)
          this.decorations = proseMarks(update.view, this.ranges);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
];
const latexHighlights=HighlightStyle.define([
  {tag:[tags.tagName,tags.keyword,tags.function(tags.variableName)],color:'var(--syntax-command)'},
  {tag:[tags.atom,tags.number,tags.string,tags.special(tags.variableName)],color:'var(--syntax-value)'},
  {tag:tags.comment,color:'var(--syntax-comment)',fontStyle:'italic'},
  {tag:[tags.bracket,tags.punctuation],color:'var(--secondary)'},
  {tag:tags.invalid,color:'var(--danger)'},
]);
export function clearEditorStates() {
  states.clear();
  scrollPositions.clear();
}
export function forgetEditorState(key: string) {
  states.delete(key);
  scrollPositions.delete(key);
}
const commands = [
  "documentclass",
  "usepackage",
  "title",
  "author",
  "date",
  "maketitle",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "label",
  "ref",
  "eqref",
  "cite",
  "textbf",
  "textit",
  "emph",
  "footnote",
  "include",
  "input",
  "includegraphics",
  "bibliography",
  "bibliographystyle",
  "tableofcontents",
  "item",
  "frac",
  "sqrt",
  "sum",
  "int",
  "alpha",
  "beta",
  "gamma",
  "theta",
];
function completions(documents: DocumentFile[]) {
  const symbols = projectSymbols(documents);
  return (context: CompletionContext) => {
    const line = context.state.sliceDoc(
      context.state.doc.lineAt(context.pos).from,
      context.pos,
    );
    const cite = line.match(/\\(?:cite\w*|ref|eqref|pageref)\{([^}]*)$/);
    if (cite) {
      const word = cite[1].split(",").at(-1) ?? "";
      return {
        from: context.pos - word.length,
        options: (/\\cite/.test(cite[0])
          ? symbols.citations
          : symbols.labels
        ).map((label) => ({ label, type: "variable" })),
      };
    }
    const match = context.matchBefore(/\\[a-zA-Z]*/);
    if (!match) return null;
    return {
      from: match.from,
      options: [
        ...commands.map((label) => ({ label: "\\" + label, type: "keyword" })),
        snippetCompletion(
          "\\begin{${environment}}\n  ${}\n\\end{${environment}}",
          { label: "\\begin", detail: "Environment", type: "keyword" },
        ),
        snippetCompletion(
          "\\begin{equation}\n  ${expression}\n  \\label{eq:${name}}\n\\end{equation}",
          { label: "\\equation", detail: "Numbered equation", type: "keyword" },
        ),
        snippetCompletion(
          "\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${file}}\n  \\caption{${caption}}\n  \\label{fig:${name}}\n\\end{figure}",
          { label: "\\figure", detail: "Figure with caption", type: "keyword" },
        ),
      ],
    };
  };
}
const theme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--editor)",
    color: "var(--text)",
    fontSize: "14px",
  },
  ".cm-scroller": {
    fontFamily: '"IBM Plex Mono", monospace',
    lineHeight: "1.75",
    overflow: "auto",
  },
  ".cm-content": { padding: "22px 0 160px", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 28px 0 16px" },
  ".cm-gutters": {
    backgroundColor: "var(--editor)",
    color: "var(--muted)",
    border: "none",
    padding: "0 4px 0 14px",
    fontSize: "12.5px",
  },
  ".cm-activeLineGutter": {
    color: "var(--accent)",
    backgroundColor: "transparent",
    fontWeight: "600",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftWidth: "2px" },
  ".cm-foldGutter .cm-gutterElement": {
    color: "var(--muted)",
    cursor: "pointer",
    padding: "0 3px",
  },
  ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--accent)" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--accent-soft)",
    border: "none",
    borderRadius: "5px",
    color: "var(--accent-text)",
    padding: "0 7px",
    margin: "0 4px",
  },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  ".cm-tooltip": {
    backgroundColor: "var(--raised)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "10px",
    boxShadow: "var(--shadow)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: '"IBM Plex Mono", monospace',
    fontSize: "13px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "4px 10px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--button-text)",
  },
  ".cm-panels": {
    backgroundColor: "var(--surface)",
    color: "var(--text)",
    fontSize: "13px",
  },
});
interface Props {
  bufferKey: string;
  initialText: string;
  documents: DocumentFile[];
  diagnostics: Diagnostic[];
  spellcheck: boolean;
  onChange: (text: string) => void;
  onCursor: (line: number, column: number) => void;
  onReady: (view: EditorView | null) => void;
}
export function Editor({
  bufferKey,
  initialText,
  documents,
  diagnostics,
  spellcheck,
  onChange,
  onCursor,
  onReady,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onCursor, onReady });
  callbacks.current = { onChange, onCursor, onReady };
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!container.current) return;
    let state = states.get(bufferKey);
    if (state && state.doc.toString() !== initialText) state = undefined;
    state ??= EditorState.create({
      doc: initialText,
      extensions: [
        lineNumbers(),
        foldGutter(),
        lintGutter(),
        history(),
        drawSelection(),
        // Ctrl+click adds a cursor, Alt+drag selects a column, Ctrl+D adds the next match.
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        StreamLanguage.define(stex),
        latexFolding,
        syntaxHighlighting(latexHighlights),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        theme,
        EditorView.contentAttributes.of({
          "aria-label": "LaTeX source editor",
        }),
        spelling.of(
          spellcheck
            ? spellChecking
            : EditorView.contentAttributes.of({ spellcheck: "false" }),
        ),
        Prec.high(
          keymap.of([
            { key: "Mod-b", run: wrapWith("textbf") },
            { key: "Mod-i", run: wrapWith("textit") },
          ]),
        ),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        completion.of(
          autocompletion({ override: [completions(documents)] }),
        ),
        updates.of([]),
      ],
    });
    const instance = new EditorView({ state, parent: container.current });
    instance.dispatch({effects: updates.reconfigure(EditorView.updateListener.of((update) => {
          if (update.docChanged)
            callbacks.current.onChange(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            const line = update.state.doc.lineAt(
              update.state.selection.main.head,
            );
            const column = update.state.selection.main.head - line.from + 1;
            if(cursorTimer.current) clearTimeout(cursorTimer.current);
            cursorTimer.current=setTimeout(()=>callbacks.current.onCursor(line.number,column),100);
          }
        }))});
    view.current = instance;
    const scroll = scrollPositions.get(bufferKey);
    if(scroll!==undefined) instance.scrollDOM.scrollTop=scroll;
    callbacks.current.onReady(instance);
    return () => {
      states.set(bufferKey, instance.state);
      scrollPositions.set(bufferKey,instance.scrollDOM.scrollTop);
      if(cursorTimer.current)clearTimeout(cursorTimer.current);
      instance.destroy();
      view.current = null;
      callbacks.current.onReady(null);
    };
    // A document's state lives in CodeMirror; React does not replace it on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bufferKey]);
  useEffect(() => {
    view.current?.dispatch({
      effects: completion.reconfigure(
        autocompletion({ override: [completions(documents)] }),
      ),
    });
  }, [documents, bufferKey]);
  useEffect(() => {
    view.current?.dispatch({
      effects: spelling.reconfigure(
        spellcheck
          ? spellChecking
          : EditorView.contentAttributes.of({ spellcheck: "false" }),
      ),
    });
  }, [spellcheck, bufferKey]);
  useEffect(()=>{
    const instance=view.current;if(!instance)return;
    instance.dispatch(setDiagnostics(instance.state, diagnostics.filter(d=>d.line&&d.line<=instance.state.doc.lines).map(d=>{
      const line=instance.state.doc.line(d.line!);
      return {from:line.from,to:line.to,severity:d.severity,message:d.message};
    })));
  },[diagnostics,bufferKey]);
  return <div className="source-editor" ref={container} />;
}

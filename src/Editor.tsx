import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
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
import { projectSymbols } from "./core";

const states = new Map<string, EditorState>();
const scrollPositions = new Map<string, number>();
// Compartments must have stable identity across editor unmounts and restored states.
const completion = new Compartment();
const updates = new Compartment();
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
    fontSize: "13px",
  },
  ".cm-scroller": {
    fontFamily: '"IBM Plex Mono", monospace',
    lineHeight: "1.85",
    overflow: "auto",
  },
  ".cm-content": { padding: "26px 0 160px", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 28px 0 16px" },
  ".cm-gutters": {
    backgroundColor: "var(--editor)",
    color: "var(--muted)",
    border: "none",
    padding: "0 4px 0 16px",
    fontSize: "11px",
  },
  ".cm-activeLineGutter": {
    color: "var(--accent)",
    backgroundColor: "transparent",
  },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  ".cm-tooltip": {
    backgroundColor: "var(--surface)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "#fff",
  },
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--text)" },
});
interface Props {
  bufferKey: string;
  initialText: string;
  documents: DocumentFile[];
  diagnostics: Diagnostic[];
  onChange: (text: string) => void;
  onCursor: (line: number, column: number) => void;
  onReady: (view: EditorView | null) => void;
}
export function Editor({
  bufferKey,
  initialText,
  documents,
  diagnostics,
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
        lintGutter(),
        history(),
        drawSelection(),
        rectangularSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        StreamLanguage.define(stex),
        syntaxHighlighting(latexHighlights),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        theme,
        EditorView.contentAttributes.of({
          "aria-label": "LaTeX source editor",
          spellcheck: "false",
        }),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
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
  useEffect(()=>{
    const instance=view.current;if(!instance)return;
    instance.dispatch(setDiagnostics(instance.state, diagnostics.filter(d=>d.line&&d.line<=instance.state.doc.lines).map(d=>{
      const line=instance.state.doc.line(d.line!);
      return {from:line.from,to:line.to,severity:d.severity,message:d.message};
    })));
  },[diagnostics,bufferKey]);
  return <div className="source-editor" ref={container} />;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countWords,
  detectEngine,
  diagnostics,
  foldEnd,
  missingFiles,
  nonProse,
  requiredFiles,
  outline,
  projectSymbols,
  relativeSource,
  resolveBuild,
  searchProject,
  syncFields,
} from "../src/core.ts";
import type { DocumentFile, Project } from "../src/types.ts";
import { SerialQueue } from '../src/serial.ts';
import {
  applySetupEvent,
  beginSetup,
  idleSetup,
  setupProgress,
} from "../src/setupState.ts";
import type { SetupEvent } from "../src/types.ts";

const docs: DocumentFile[] = [
  {
    path: "main.tex",
    revision: "a",
    text: String.raw`\documentclass{article}
% \section{Not a section}
\section{Introduction}
\label{sec:intro}
\subsection*{A question}
Research in বাংলা.
`,
  },
  {
    path: "references.bib",
    revision: "b",
    text: "@book{knuth1984,\n title={The TeXbook}\n}\n@article {smith2025,\n title={A paper}\n}\n",
  },
];
const project: Project = {
  id: "p",
  name: "Test",
  directory: "D:/Research",
  files: [
    { path: "main.tex", size: 100, editable: true },
    { path: "chapters/intro.tex", size: 100, editable: true },
  ],
  roots: ["main.tex"],
  folders: [],
  config: {
    version: 1,
    root: null,
    engine: null,
    shellEscape: false,
    latexmkrc: false,
  },
};

test("outline ignores commented commands and preserves line/file locations", () => {
  assert.deepEqual(outline(docs), [
    { title: "Introduction", line: 3, level: 1, path: "main.tex" },
    { title: "A question", line: 5, level: 2, path: "main.tex" },
  ]);
});
test("indexes bibliography keys and labels across files", () => {
  assert.deepEqual(projectSymbols(docs), {
    labels: ["sec:intro"],
    citations: ["knuth1984", "smith2025"],
  });
});
test("search is literal, case insensitive, Unicode-aware and bounded", () => {
  assert.equal(searchProject(docs, "RESEARCH")[0].line, 6);
  assert.equal(searchProject(docs, "বাংলা")[0].path, "main.tex");
  assert.equal(searchProject(docs, "[").length, 0);
  assert.equal(
    searchProject(
      [{ path: "large.tex", revision: "a", text: "match\n".repeat(1000) }],
      "match",
    ).length,
    200,
  );
  assert.deepEqual(searchProject(docs, " "), []);
});
test("parses Windows diagnostic paths and nearby TeX error line numbers", () => {
  const result = diagnostics(
    "D:\\My paper\\main.tex:23: Undefined control sequence.\n! Missing $ inserted.\n<inserted text>\n$\nl.32 equation\nLaTeX Warning: Reference `eq:x' undefined on input line 47.",
  );
  assert.equal(result[0].path, "D:/My paper/main.tex");
  assert.equal(result[0].line, 23);
  assert.equal(result[1].line, 32);
  assert.equal(result[2].severity, "warning");
  assert.equal(result[2].line, 47);
});
test("diagnostics are deduplicated without collapsing different locations", () => {
  const result = diagnostics(
    "./main.tex:4: Error\n./main.tex:4: Error\n./main.tex:5: Error",
  );
  assert.equal(result.length, 2);
});
test("project config overrides magic comments and engine defaults", () => {
  const active = {
    path: "chapters/intro.tex",
    revision: "a",
    text: "% !TeX root = ../main.tex\n% !TeX program = XeLaTeX",
  };
  assert.deepEqual(resolveBuild(project, active), {
    root: "main.tex",
    engine: "xelatex",
  });
  assert.deepEqual(
    resolveBuild(
      {
        ...project,
        config: {
          ...project.config,
          root: "chapters/intro.tex",
          engine: "lualatex",
        },
      },
      active,
    ),
    { root: "chapters/intro.tex", engine: "lualatex" },
  );
  assert.deepEqual(resolveBuild(project), {
    root: "main.tex",
    engine: "pdflatex",
  });
});
test("ambiguous or missing root requires an explicit choice", () => {
  assert.equal(
    resolveBuild({ ...project, roots: ["main.tex", "appendix.tex"] }).root,
    null,
  );
  assert.equal(resolveBuild({ ...project, roots: [] }).root, null);
});
test("invalid engine magic comments never become process arguments", () => {
  assert.equal(
    resolveBuild(project, {
      path: "main.tex",
      revision: "a",
      text: "% !TeX program = powershell",
    }).engine,
    "pdflatex",
  );
});
test("SyncTeX fields preserve Windows path colons and first result", () => {
  const result = syncFields(
    "SyncTeX result begin\nInput:D:\\Paper\\main.tex\nLine:12\nPage:2\nPage:3\n",
  );
  assert.equal(result.Input, "D:\\Paper\\main.tex");
  assert.equal(result.Page, "2");
});
test("source navigation rejects paths outside the project", () => {
  assert.equal(
    relativeSource("D:\\Research", "D:\\Research\\main.tex"),
    "main.tex",
  );
  assert.equal(
    relativeSource("\\\\?\\D:\\Research", "D:\\Research\\main.tex"),
    "main.tex",
  );
  assert.equal(
    relativeSource("D:/Research", "D:/Research-other/main.tex"),
    null,
  );
  assert.equal(relativeSource("D:/Research", "../private.tex"), null);
  assert.equal(relativeSource("D:/Research", "D:/Research/../private.tex"), null);
  assert.equal(
    relativeSource("D:/Research", "./chapters/intro.tex"),
    "chapters/intro.tex",
  );
});
test('an escaping magic root never resolves to a similarly named local file',()=>{
  const ambiguous={...project,roots:[]};
  assert.equal(resolveBuild(ambiguous,{path:'main.tex',revision:'a',text:'% !TeX root = ../main.tex'}).root,null);
});
test('serial disk mutations remain ordered after a failed save',async()=>{
  const queue=new SerialQueue();const calls:number[]=[];
  const first=queue.run(async()=>{await new Promise(resolve=>setTimeout(resolve,5));calls.push(1);throw new Error('conflict');});
  const second=queue.run(async()=>{calls.push(2);return 'saved';});
  await assert.rejects(first,/conflict/);assert.equal(await second,'saved');assert.deepEqual(calls,[1,2]);
});

test("missing package files are found, but missing project files are not offered for install", () => {
  const log = [
    "! LaTeX Error: File `kvsetkeys.sty' not found.",
    "! LaTeX Error: File `IEEEtran.cls' not found.",
    "! LaTeX Error: File `kvsetkeys.sty' not found.",
    "! LaTeX Error: File `chapter.tex' not found.",
    "! I can't find file `fancyhdr.sty'.",
    "! Font T1/cmr/m/n/10=ecrm1000 at 10.0pt not loadable: Metric (TFM) file not found.",
  ].join("\n");
  assert.deepEqual(missingFiles(log), [
    "kvsetkeys.sty",
    "IEEEtran.cls",
    "fancyhdr.sty",
    "ecrm1000.tfm",
  ]);
  assert.deepEqual(missingFiles("Output written on main.pdf (1 page)."), []);
});
test("setup progress follows its own run and ignores stale runs", () => {
  const run = (event: Record<string, unknown>) =>
    ({ runId: "current", ...event }) as SetupEvent;
  let view = beginSetup(idleSetup(), "current");
  assert.equal(setupProgress(view), 0);
  view = applySetupEvent(view, run({ kind: "step", step: "tools", state: "done", text: "Found MiKTeX 26.5 and latexmk" }));
  view = applySetupEvent(view, run({ kind: "progress", step: "packages", done: 1, total: 2, text: "Installing pgfplots" }));
  assert.equal(view.steps.packages.text, "Installing pgfplots");
  assert.ok(Math.abs(setupProgress(view) - 0.4) < 1e-9);
  const stale = applySetupEvent(view, { ...run({ kind: "line", text: "old" }), runId: "previous" });
  assert.equal(stale, view);
  view = applySetupEvent(view, run({ kind: "finished", success: false, failure: { step: "packages", problem: "download", text: "Couldn't install pgfplots.\ncurl error 6" } }));
  assert.equal(view.status, "failed");
  assert.equal(view.steps.packages.state, "failed");
  assert.equal(view.steps.packages.text, "Couldn't install pgfplots.");
  view = beginSetup(view, "next");
  assert.equal(view.failure, undefined);
  assert.equal(view.steps.tools.state, "pending");
});
test("the engine is detected from what the document loads", () => {
  assert.equal(detectEngine(String.raw`\usepackage{amsmath,fontspec}`), "xelatex");
  assert.equal(detectEngine(String.raw`\setmainfont{Times New Roman}`), "xelatex");
  assert.equal(detectEngine(String.raw`\usepackage[bangla]{polyglossia}`), "xelatex");
  assert.equal(detectEngine(String.raw`\usepackage{luacode}`), "lualatex");
  assert.equal(detectEngine(String.raw`\usepackage{luatexja-fontspec}`), "lualatex");
  assert.equal(detectEngine(String.raw`% \usepackage{fontspec}`), null);
  assert.equal(detectEngine(String.raw`\usepackage{myfontspecial}`), null);
  // A preamble that branches on the engine works with any engine.
  assert.equal(
    detectEngine(String.raw`\ifxetex\usepackage{fontspec}\else\usepackage[utf8]{inputenc}\fi`),
    null,
  );
});
test("settings and magic comments win over detection, which follows a separate preamble", () => {
  const overleaf: Project = {
    ...project,
    roots: ["main.tex"],
    files: [
      { path: "main.tex", size: 1, editable: true },
      { path: "preamble.tex", size: 1, editable: true },
      { path: "chapter.tex", size: 1, editable: true },
    ],
  };
  const files = (main: string): DocumentFile[] => [
    { path: "main.tex", revision: "a", text: main },
    { path: "preamble.tex", revision: "b", text: String.raw`\usepackage{fontspec}` },
    { path: "chapter.tex", revision: "c", text: "Text" },
  ];
  const main = String.raw`\documentclass{article}\input{preamble}`;
  const chapter = files(main)[2];
  assert.equal(resolveBuild(overleaf, chapter, files(main)).engine, "xelatex");
  assert.equal(
    resolveBuild(overleaf, chapter, files("% !TeX program = lualatex\n" + main)).engine,
    "lualatex",
  );
  assert.equal(
    resolveBuild(
      { ...overleaf, config: { ...overleaf.config, engine: "pdflatex" } },
      chapter,
      files(main),
    ).engine,
    "pdflatex",
  );
  assert.equal(
    resolveBuild(overleaf, chapter, files(String.raw`\documentclass{article}`)).engine,
    "pdflatex",
  );
});
test("spell checking and word counts skip commands, math, names and comments", () => {
  const text = String.raw`See \textbf{teh} result in \cref{fig:plot} and \citep[p.~2]{knuth1984}, where $x^2$ grows. % notte
\begin{equation}
  E = mc^2
\end{equation}`;
  const skipped = nonProse(text).map(([from, to]) => text.slice(from, to));
  assert.ok(skipped.includes("\\textbf"));
  assert.ok(skipped.includes("\\cref{fig:plot}"));
  assert.ok(skipped.includes("\\citep[p.~2]{knuth1984}"));
  assert.ok(skipped.includes("$x^2$"));
  assert.ok(skipped.includes("% notte"));
  assert.ok(skipped.some((part) => part.startsWith("\\begin{equation}") && part.endsWith("\\end{equation}")));
  // Prose inside formatting stays checkable.
  assert.ok(!skipped.some((part) => part.includes("teh")));
});
test("word count follows included files and keeps Bangla words whole", () => {
  const docs: DocumentFile[] = [
    {
      path: "main.tex",
      revision: "a",
      text: String.raw`\documentclass{article}
\usepackage{graphicx} preamble words are not counted
\begin{document}
Hello \emph{bright} world, see \ref{sec:a} and $a+b$.
\input{chapters/intro}
% \input{chapters/skipped}
\end{document}`,
    },
    { path: "chapters/intro.tex", revision: "b", text: "আমার সোনার বাংলা, a well-known song." },
    { path: "chapters/skipped.tex", revision: "c", text: "Not part of the document." },
  ];
  // Hello, bright, world, see, and; then আমার, সোনার, বাংলা, a, well-known, song.
  assert.equal(countWords("main.tex", docs), 11);
  assert.equal(countWords(null, docs), 0);
});
test("folds reach the matching end or the next heading at the same level", () => {
  const lines = String.raw`\section{One}
Intro text.
\subsection{Detail}
\begin{figure}
  \begin{figure}
  \end{figure}
\end{figure}

\section{Two}
Last.
\end{document}`.split("\n");
  const line = (n: number) => lines[n - 1];
  assert.deepEqual(foldEnd(line, lines.length, 1), { line: 7, column: 12 });
  assert.deepEqual(foldEnd(line, lines.length, 3), { line: 7, column: 12 });
  assert.deepEqual(foldEnd(line, lines.length, 4), { line: 7, column: 0 });
  assert.deepEqual(foldEnd(line, lines.length, 9), { line: 10, column: 5 });
  assert.equal(foldEnd(line, lines.length, 2), null);
});
test("command names that start like a shorter one still skip their argument", () => {
  const text = String.raw`Text \includegraphics[width=3cm]{figures/plot.png} and \inputminted{python}{code.py}.`;
  const skipped = nonProse(text).map(([from, to]) => text.slice(from, to));
  assert.ok(skipped.includes(String.raw`\includegraphics[width=3cm]{figures/plot.png}`));
  assert.ok(skipped.includes(String.raw`\inputminted{python}`));
  // Text, and, plus the second argument of \inputminted: code, py.
  assert.equal(
    countWords("main.tex", [{ path: "main.tex", revision: "a", text }]),
    4,
  );
});
test("the packages and classes a project loads are found, except its own files", () => {
  const docs: DocumentFile[] = [
    {
      path: "main.tex",
      revision: "a",
      text: String.raw`\documentclass[conference]{IEEEtran}
\usepackage[ruled,vlined]{algorithm2e}
\usepackage{amsmath, graphicx}
% \usepackage{commentedout}
\usepackage{mystyle}
\usepackage{\foo}`,
    },
    { path: "styles/mystyle.sty", revision: "b", text: String.raw`\RequirePackage{tikz}` },
    { path: "notes.txt", revision: "c", text: String.raw`\usepackage{ignored}` },
  ];
  assert.deepEqual(requiredFiles(docs, ["main.tex", "styles/mystyle.sty", "notes.txt"]), [
    "IEEEtran.cls",
    "algorithm2e.sty",
    "amsmath.sty",
    "graphicx.sty",
    "tikz.sty",
  ]);
});

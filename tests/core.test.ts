import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diagnostics,
  outline,
  projectSymbols,
  relativeSource,
  resolveBuild,
  searchProject,
  syncFields,
} from "../src/core.ts";
import type { DocumentFile, Project } from "../src/types.ts";
import { SerialQueue } from '../src/serial.ts';

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
  config: { version: 1, root: null, engine: null, shellEscape: false },
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

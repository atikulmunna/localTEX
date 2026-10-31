import type { DocumentFile, Project } from "./types";
export const sample = String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[T1]{fontenc}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage[hidelinks]{hyperref}

\title{A little space for big ideas}
\author{Your name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Every good paper begins with a question.
This is a space to explore yours.
\end{abstract}

\section{Introduction}
\label{sec:introduction}
Good research makes room for curiosity. Start with
the problem, explain why it matters, and invite
the reader into your work.

\section{Approach}
An elegant idea can often be expressed simply:
\begin{equation}
  E = mc^2
  \label{eq:energy}
\end{equation}
Equation~\ref{eq:energy} connects energy and mass.

\section{Discussion}
What did you discover? What questions remain?

\section{Conclusion}
Bring the reader back to the idea that started it all.
\end{document}
`;
export const demoDocuments: DocumentFile[] = [
  { path: "main.tex", text: sample, revision: "demo" },
  {
    path: "references.bib",
    text: "@book{knuth1984,\n  title = {The TeXbook},\n  author = {Donald E. Knuth},\n  year = {1984}\n}\n",
    revision: "demo",
  },
];
export const demoProject: Project = {
  id: "preview",
  name: "A little space for big ideas",
  directory: "Browser preview · files stay in this browser",
  roots: ["main.tex"],
  folders: [],
  files: demoDocuments.map((d) => ({
    path: d.path,
    size: d.text.length,
    editable: true,
  })),
  config: {
    version: 1,
    root: null,
    engine: null,
    shellEscape: false,
    latexmkrc: false,
  },
};

pub const ARTICLE: &str = r#"\documentclass[11pt,a4paper]{article}
\usepackage[T1]{fontenc}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage[hidelinks]{hyperref}

\title{A little space for big ideas}
\author{Your name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Every good paper begins with a question. This is a space to explore yours.
\end{abstract}

\section{Introduction}
\label{sec:introduction}
Good research makes room for curiosity. Start with the problem,
explain why it matters, and invite the reader into your work.

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

% Add citations with \cite{knuth1984}, then uncomment:
% \bibliographystyle{plain}
% \bibliography{references}
\end{document}
"#;
pub const THESIS: &str = r#"\documentclass[12pt,a4paper]{report}
\usepackage[T1]{fontenc}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage[hidelinks]{hyperref}
\title{A question worth exploring}
\author{Your name}
\date{\today}
\begin{document}
\maketitle
\begin{abstract}
A brief account of your question, method, and contribution.
\end{abstract}
\tableofcontents
\include{introduction}
\chapter{Methods}
Describe how the research was conducted.
\chapter{Results and discussion}
Present your findings and explain their significance.
\chapter{Conclusion}
Reflect on the contribution and future work.
% \bibliographystyle{plain}
% \bibliography{references}
\end{document}
"#;
pub const BIB: &str = "@book{knuth1984,\n  author = {Donald E. Knuth},\n  title = {The TeXbook},\n  year = {1984},\n  publisher = {Addison-Wesley}\n}\n";

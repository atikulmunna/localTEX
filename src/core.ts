import type {
  Diagnostic,
  DocumentFile,
  Engine,
  OutlineItem,
  Project,
  SearchResult,
} from "./types.ts";

export function outline(documents: DocumentFile[]): OutlineItem[] {
  return documents.flatMap((doc) =>
    doc.text.split("\n").flatMap((text, index) => {
      const match = text.match(
        /^\s*\\(chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{([^}]*)\}/,
      );
      return match
        ? [
            {
              title: match[2],
              line: index + 1,
              level: [
                "chapter",
                "section",
                "subsection",
                "subsubsection",
              ].indexOf(match[1]),
              path: doc.path,
            },
          ]
        : [];
    }),
  );
}
export function projectSymbols(documents: DocumentFile[]) {
  const labels = new Set<string>(),
    citations = new Set<string>();
  for (const doc of documents) {
    for (const match of doc.text.matchAll(/\\label\{([^}]+)\}/g))
      labels.add(match[1]);
    for (const match of doc.text.matchAll(
      /@(?:article|book|inproceedings|misc|incollection|phdthesis|mastersthesis|techreport|online|proceedings|manual|unpublished)\s*\{\s*([^,\s]+),/gi,
    ))
      citations.add(match[1]);
  }
  return { labels: [...labels], citations: [...citations] };
}
export function searchProject(
  documents: DocumentFile[],
  query: string,
): SearchResult[] {
  if (!query.trim()) return [];
  const needle = query.toLocaleLowerCase();
  const results: SearchResult[] = [];
  for (const doc of documents) {
    for (const [i, text] of doc.text.split("\n").entries()) {
      if (text.toLocaleLowerCase().includes(needle))
        results.push({ path: doc.path, line: i + 1, text: text.trim() });
      if (results.length >= 200) return results;
    }
  }
  return results;
}
/** latexmk's own lines, which TeX never wrapped, so nothing is joined onto them. */
const messageStart = /^(?:Latexmk|Rule |Run number|-{6,})/;
/**
 * TeX wraps its terminal output at 79 columns, which splits long paths and messages.
 * localTEX widens that where the engine allows; this rejoins what is still split. A
 * message exactly 79 columns long is followed by an empty line, so it stays as it is.
 */
function unwrap(log: string): string[] {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  for (const raw of log.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const previous = lines.at(-1);
    const full = (text: string) =>
      text.length === 79 || encoder.encode(text).length === 79;
    if (previous !== undefined && full(previous.split("\u0000").at(-1)!) && line && !messageStart.test(line))
      lines[lines.length - 1] = previous + "\u0000" + line;
    else lines.push(line);
  }
  // The marker only remembers where the last piece began; it is not part of the text.
  return lines.map((line) => line.replaceAll("\u0000", ""));
}
const sourceFile =
  /^(.+?\.(?:tex|sty|cls|bbl|ltx|dtx|clo|def|cfg|fd|aux|toc|lof|lot|ind|gls|nls|tikz|pgf)):(\d+):\s*(.+)/;
/** Errors first, then warnings, then the overfull and underfull boxes that rarely matter. */
const rank = (d: Diagnostic) =>
  d.severity === "error" ? 0 : /^(?:Over|Under)full /.test(d.message) ? 2 : 1;
export function diagnostics(log: string): Diagnostic[] {
  const results: Diagnostic[] = [];
  const lines = unwrap(log);
  // latexmk runs LaTeX several times. Earlier passes warn about citations and references
  // that the last pass resolves, so only the last pass (and anything after it) counts.
  let start = 0;
  lines.forEach((line, i) => {
    if (/^Run number \d+ of rule '(?:pdf|xe|lua)?latex'/.test(line)) start = i;
  });
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    const location = line.match(sourceFile);
    // TeX's closing notice that it stopped, which repeats the error above it.
    if (location && /^==> Fatal error occurred/.test(location[3])) continue;
    if (location) {
      // LaTeX continues a long message on indented lines, up to a blank one.
      let message = location[3];
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (!/^\s+\S/.test(lines[j])) break;
        message += " " + lines[j].trim();
      }
      const path = location[1].replace(/^\.\//, "").replaceAll("\\", "/");
      if (path.endsWith(".bbl")) {
        // The .bbl is generated from the .bib file; quote the text so the entry can be found.
        const context = lines
          .slice(i + 1, i + 14)
          .map((l) => l.match(/^l\.\d+\s+(.*\S)/)?.[1])
          .find(Boolean)
          ?.replace(/^\.\.\./, "");
        results.push({
          severity: "error",
          bibliography: true,
          message: `In the bibliography: ${message}${context ? ` Near “${context}”.` : ""}`,
        });
      } else
        results.push({
          severity: "error",
          path,
          line: Number(location[2]),
          message,
        });
    } else if (/^!\s/.test(line)) {
      const nearby = lines
        .slice(i + 1, i + 6)
        .join("\n")
        .match(/\bl\.(\d+)/);
      results.push({
        severity: "error",
        message: line.slice(2),
        line: nearby ? Number(nearby[1]) : undefined,
      });
    } else if (
      /^(?:LaTeX|Package .+|Class .+) Warning:/.test(line) ||
      /^(?:Over|Under)full \\[hv]box/.test(line)
    ) {
      results.push({
        severity: "warning",
        message: line,
        line:
          Number(line.match(/(?:input line|lines?) (\d+)/)?.[1]) || undefined,
      });
    }
  }
  return results
    .filter(
      (v, i, a) =>
        a.findIndex(
          (x) =>
            x.message === v.message && x.path === v.path && x.line === v.line,
        ) === i,
    )
    .sort((a, b) => rank(a) - rank(b));
}
// Only package-provided files can be installed; a missing chapter.tex is the author's to fix.
const packageFile = /\.(?:sty|cls|def|fd|cfg|clo|bst|bbx|cbx|lbx|dbx|tfm)$/;
/** Package files a failed build could not find, for example ["kvsetkeys.sty"]. */
export function missingFiles(log: string): string[] {
  const files = new Set<string>();
  for (const match of log.matchAll(
    /(?:File|can't find file) [`']([^'`\s]+)' not found|I can't find file [`']([^'`\s]+)'/g,
  )) {
    const file = match[1] ?? match[2];
    if (packageFile.test(file)) files.add(file);
  }
  for (const match of log.matchAll(
    /Font \S+=(\S+) at \S+ not loadable: Metric \(TFM\) file not found/g,
  ))
    files.add(`${match[1]}.tfm`);
  return [...files];
}
const engines: Engine[] = ["pdflatex", "xelatex", "lualatex"];
const magicProgram = (text?: string): Engine | null => {
  const name = text
    ?.match(/^\s*%\s*!\s*TeX\s+(?:program|TS-program)\s*=\s*(\w+)/im)?.[1]
    .toLowerCase();
  return engines.includes(name as Engine) ? (name as Engine) : null;
};
const withoutComments = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/(^|[^\\])%.*/, "$1"))
    .join("\n");
/** The engine a document needs when nothing names one. Overleaf downloads don't record it. */
export function detectEngine(text: string): Engine | null {
  const source = withoutComments(text);
  // A preamble that branches on the engine works with any of them.
  if (/\\if(?:xetex|luatex|tutex|pdftex|XeTeX|LuaTeX|PDFTeX)\b/.test(source))
    return null;
  const loads = (names: string) =>
    new RegExp(
      String.raw`\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\b(?:${names})\b`,
    ).test(source);
  if (
    loads("luacode|luatexja|luamplib|lua-ul|luacolor") ||
    /\\directlua\b/.test(source)
  )
    return "lualatex";
  if (
    loads("fontspec|unicode-math|polyglossia|xeCJK|xltxtra|xunicode|mathspec") ||
    /\\(?:setmainfont|setsansfont|setmonofont|newfontfamily)\b/.test(source)
  )
    return "xelatex";
  return null;
}
/** Project files a root loads directly, such as a preamble.tex or its own .sty. */
function loadedBy(root: string, documents: DocumentFile[], text: string) {
  const folder = root.split("/").slice(0, -1);
  const loaded = [
    ...withoutComments(text).matchAll(
      /\\(?:input|include|usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]+)\}/g,
    ),
  ].flatMap((match) => match[1].split(",").map((name) => name.trim()));
  const parts = loaded.flatMap((name) =>
    [name, `${name}.tex`, `${name}.sty`].map((file) =>
      [...folder, file].join("/"),
    ),
  );
  return documents.filter((d) => d.path !== root && parts.includes(d.path));
}
/** The root's text plus the project files it loads directly, such as a preamble.tex. */
function rootSource(root: string, documents: DocumentFile[], text?: string) {
  if (text === undefined) return "";
  return [text, ...loadedBy(root, documents, text).map((d) => d.text)].join(
    "\n",
  );
}
/** Comments turned into spaces, so positions in the result match the original text. */
const blankComments = (text: string) =>
  text.replace(
    /(^|[^\\])(%[^\n]*)/gm,
    (_, before: string, comment: string) => before + " ".repeat(comment.length),
  );
/** Where a document turns on draft figures: the option's text and position in its file. */
export interface DraftFigures {
  path: string;
  line: number;
  from: number;
  to: number;
  /** The option as written, for example "draft". */
  option: string;
}
/**
 * Where LaTeX is told to draw figures as empty boxes with their file names: a draft class
 * option (which graphicx follows) or a draft option for graphicx itself. A final option for
 * graphicx overrides a draft class. Checks the root and the files it loads directly.
 */
export function draftFigures(
  root: string | null,
  documents: DocumentFile[],
): DraftFigures | null {
  const main = documents.find((d) => d.path === root);
  if (!root || !main) return null;
  let classDraft: DraftFigures | null = null;
  let graphicsDraft: DraftFigures | null = null;
  let graphicsFinal = false;
  for (const doc of [main, ...loadedBy(root, documents, main.text)]) {
    const text = blankComments(doc.text);
    // Each option in a comma-separated list that starts at `start` in the file.
    const options = (list: string, start: number) =>
      [...list.matchAll(/[^,]+/g)]
        .filter((m) => m[0].trim())
        .map((m) => {
          const option = m[0].trim();
          const from = start + m.index! + m[0].indexOf(option);
          return {
            name: option.replace(/\s+/g, ""),
            at: {
              path: doc.path,
              line: text.slice(0, from).split("\n").length,
              from,
              to: from + option.length,
              option,
            },
          };
        });
    const documentClass = text.match(/\\documentclass\s*\[([^\]]*)\]/);
    if (documentClass && !classDraft)
      classDraft =
        options(
          documentClass[1],
          documentClass.index! + documentClass[0].indexOf("[") + 1,
        ).find((o) => o.name === "draft")?.at ?? null;
    const graphics = [
      ...[
        ...text.matchAll(
          /\\(?:usepackage|RequirePackage)\s*\[([^\]]*)\]\s*\{([^}]*)\}/g,
        ),
      ].map((m) => [m[1], m[2], m.index! + m[0].indexOf("[") + 1] as const),
      ...[
        ...text.matchAll(/\\PassOptionsToPackage\s*\{([^}]*)\}\s*\{([^}]*)\}/g),
      ].map((m) => [m[1], m[2], m.index! + m[0].indexOf("{") + 1] as const),
      ...[...text.matchAll(/\\setkeys\s*\{Gin\}\s*\{([^}]*)\}/g)].map(
        (m) => [m[1], "graphicx", m.index! + m[0].lastIndexOf("{") + 1] as const,
      ),
    ];
    for (const [list, packages, start] of graphics) {
      if (!/(^|,)\s*graphic[sx]\s*(,|$)/.test(packages)) continue;
      for (const o of options(list, start)) {
        if (o.name === "draft" || o.name === "draft=true") graphicsDraft ??= o.at;
        if (o.name === "final" || o.name === "draft=false") graphicsFinal = true;
      }
    }
  }
  return graphicsDraft ?? (graphicsFinal ? null : classDraft);
}
/**
 * The document to compile when several files start with \documentclass, as templates
 * often ship extra ones (an Elsevier highlights.tex, standalone figures): main.tex,
 * otherwise the only one at the top of the project. Null when that is still unclear.
 */
export function mainDocument(roots: string[]): string | null {
  if (roots.length === 1) return roots[0];
  const only = (list: string[]) => (list.length === 1 ? list[0] : null);
  const top = roots.filter((r) => !r.includes("/"));
  const main = roots.filter((r) => r.split("/").pop()?.toLowerCase() === "main.tex");
  return only(main.filter((r) => top.includes(r))) ?? only(main) ?? only(top);
}
export function resolveBuild(
  project: Project,
  active?: DocumentFile,
  documents: DocumentFile[] = [],
): { root: string | null; engine: Engine } {
  const magicRoot = active?.text
    .match(/^\s*%\s*!\s*TeX\s+root\s*=\s*(.+)$/im)?.[1]
    .trim();
  let resolvedMagic: string | null = null;
  if (magicRoot && active) {
    const parts = active.path.split("/").slice(0, -1);
    let valid = !/^(?:[A-Za-z]:|[\\/])/.test(magicRoot);
    for (const part of magicRoot.replaceAll("\\", "/").split("/")) {
      if (part === "..") { if(parts.length)parts.pop();else valid=false; }
      else if (part !== "." && part !== "") parts.push(part);
    }
    const candidate = parts.join("/");
    if (
      valid && project.files.some((f) => f.path === candidate && f.path.endsWith(".tex"))
    )
      resolvedMagic = candidate;
  }
  const root =
    project.config.root ??
    resolvedMagic ??
    mainDocument(project.roots);
  const rootText =
    root === null
      ? undefined
      : active?.path === root
        ? active.text
        : documents.find((d) => d.path === root)?.text;
  return {
    root,
    engine:
      project.config.engine ??
      magicProgram(active?.text) ??
      magicProgram(rootText) ??
      (root === null
        ? null
        : detectEngine(rootSource(root, documents, rootText))) ??
      "pdflatex",
  };
}
export function syncFields(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0 && !(line.slice(0, i) in result))
      result[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return result;
}
export function relativeSource(
  projectDirectory: string,
  source: string,
): string | null {
  const normalized = source.replaceAll("\\", "/").replace(/^\/\/\?\//, "");
  const root = projectDirectory
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/$/, "");
  if (normalized.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    const relative = normalized.slice(root.length + 1).replace(/^\.\//, "");
    return relative.split('/').includes('..') ? null : relative;
  }
  if (
    !/^(?:[A-Za-z]:|\/)/.test(normalized) &&
    !normalized.split("/").includes("..")
  )
    return normalized.replace(/^\.\//, "");
  return null;
}

// Commands whose first argument is a name, key, path or setting rather than prose.
const nameArguments =
  "label|ref|eqref|pageref|autoref|cref|Cref|nameref|cite\\w*|nocite|begin|end|usepackage|RequirePackage|documentclass|input|include|includeonly|includegraphics|subfile|bibliography|bibliographystyle|addbibresource|graphicspath|url|href|hypersetup|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|DeclareMathOperator|setlength|addtolength|setcounter|addtocounter|definecolor|color|textcolor|colorbox|pagestyle|thispagestyle|pagenumbering|lstinputlisting|inputminted|lstset|geometry|vspace|hspace";
const mathEnvironments =
  "equation|align|alignat|flalign|gather|multline|eqnarray|math|displaymath";
const codeEnvironments = "verbatim|lstlisting|minted|comment";
const nonProsePatterns = [
  /(^|[^\\])%.*/g,
  new RegExp(String.raw`\\begin\{(${mathEnvironments}|${codeEnvironments})\*?\}[\s\S]*?\\end\{\1\*?\}`, "g"),
  /\$\$[\s\S]*?\$\$/g,
  /\\\[[\s\S]*?\\\]/g,
  /\\\([\s\S]*?\\\)/g,
  /\$(?:\\.|[^$\\\n])+\$/g,
  // The lookahead stops \include from matching only the start of \includegraphics.
  new RegExp(String.raw`\\(?:${nameArguments})(?![a-zA-Z@])\*?(?:\s*\[[^\]\n]*\])*(?:\s*\{[^{}\n]*\})?`, "g"),
  /\\[a-zA-Z@]+\*?|\\./g,
];
/**
 * Ranges of LaTeX source that are not prose: commands, math, code, comments, and names
 * such as labels or file paths. Spell checking and the word count skip them.
 */
export function nonProse(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const pattern of nonProsePatterns)
    for (const match of text.matchAll(pattern)) {
      // A comment match may begin with the character before the %.
      const skip = pattern === nonProsePatterns[0] ? match[1].length : 0;
      ranges.push([match.index + skip, match.index + match[0].length]);
    }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}
// Letters with their combining marks, so Bangla and other Indic words stay whole.
const word = /[\p{L}\p{M}\p{N}]+(?:[-'’][\p{L}\p{M}\p{N}]+)*/gu;
function proseWords(text: string) {
  let prose = "";
  let last = 0;
  for (const [from, to] of nonProse(text)) {
    prose += text.slice(last, from) + " ";
    last = to;
  }
  prose += text.slice(last);
  return prose.match(word)?.length ?? 0;
}
/**
 * Words in the document text, following \input and \include from the root. The preamble,
 * commands, math, and comments are left out, as texcount does.
 */
export function countWords(root: string | null, documents: DocumentFile[]) {
  if (!root) return 0;
  const texts = new Map(documents.map((d) => [d.path, d.text]));
  // LaTeX resolves \input paths from the root's folder, whichever file contains them.
  const folder = root.split("/").slice(0, -1);
  const seen = new Set<string>();
  const visit = (path: string, isRoot: boolean): number => {
    let text = texts.get(path);
    if (text === undefined || seen.has(path)) return 0;
    seen.add(path);
    if (isRoot) {
      const start = text.indexOf("\\begin{document}");
      const end = text.indexOf("\\end{document}");
      if (start >= 0)
        text = text.slice(start + "\\begin{document}".length, end > start ? end : undefined);
    }
    let total = proseWords(text);
    for (const match of withoutComments(text).matchAll(
      /\\(?:input|include|subfile)\{([^}]+)\}/g,
    )) {
      const name = [...folder, match[1].trim()].join("/").replace(/^\.\//, "");
      total += texts.has(name) ? visit(name, false) : visit(`${name}.tex`, false);
    }
    return total;
  };
  return visit(root, true);
}
const sectionLevels: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};
const headingLine =
  /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/;
/**
 * Where a fold that starts on `start` ends: the line before the next heading of the same
 * or a higher level, or the matching \end of an environment. Line numbers start at 1;
 * `column` is where the folded text stops on the end line.
 */
export function foldEnd(
  line: (n: number) => string,
  total: number,
  start: number,
): { line: number; column: number } | null {
  const limit = Math.min(total, start + 5000);
  const first = line(start);
  const heading = first.match(headingLine);
  if (heading) {
    const level = sectionLevels[heading[1]];
    let end = start;
    for (let n = start + 1; n <= limit; n++) {
      const text = line(n);
      const next = text.match(headingLine);
      if (
        (next && sectionLevels[next[1]] <= level) ||
        /^\s*\\(?:end\{document\}|appendix\b|printbibliography\b|bibliography\{)/.test(text)
      )
        break;
      end = n;
    }
    while (end > start && !line(end).trim()) end--;
    return end > start ? { line: end, column: line(end).length } : null;
  }
  const begin = first.match(/\\begin\{([^}]+)\}/);
  if (!begin) return null;
  let depth = 0;
  for (let n = start; n <= limit; n++) {
    const text = n === start ? first.slice(begin.index) : line(n);
    for (const match of text.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
      if (match[2] !== begin[1]) continue;
      depth += match[1] === "begin" ? 1 : -1;
      if (depth === 0)
        return n > start ? { line: n, column: match.index } : null;
    }
  }
  return null;
}
/** Package and class files the documents load, except those the project provides itself. */
export function requiredFiles(documents: DocumentFile[], projectFiles: string[]) {
  const local = new Set(
    projectFiles.map((path) => path.split("/").at(-1)!.toLowerCase()),
  );
  const files = new Set<string>();
  const add = (file: string) => {
    if (/^[A-Za-z0-9@_.-]+\.(?:sty|cls)$/.test(file) && !local.has(file.toLowerCase()))
      files.add(file);
  };
  for (const doc of documents) {
    if (!/\.(?:tex|sty|cls)$/i.test(doc.path)) continue;
    const source = withoutComments(doc.text);
    for (const match of source.matchAll(
      /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g,
    ))
      for (const name of match[1].split(",")) add(`${name.trim()}.sty`);
    for (const match of source.matchAll(
      /\\(?:documentclass|LoadClass)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g,
    ))
      add(`${match[1].trim()}.cls`);
  }
  return [...files].sort();
}

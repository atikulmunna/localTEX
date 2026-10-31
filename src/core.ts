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
export function diagnostics(log: string): Diagnostic[] {
  const results: Diagnostic[] = [];
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const location = line.match(/^(.+?\.(?:tex|sty|cls)):(\d+):\s*(.+)/);
    if (location)
      results.push({
        severity: "error",
        path: location[1].replace(/^\.\//, "").replaceAll("\\", "/"),
        line: Number(location[2]),
        message: location[3],
      });
    else if (/^!\s/.test(line)) {
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
  return results.filter(
    (v, i, a) =>
      a.findIndex(
        (x) =>
          x.message === v.message && x.path === v.path && x.line === v.line,
      ) === i,
  );
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
/** The root's text plus the project files it loads directly, such as a preamble.tex. */
function rootSource(root: string, documents: DocumentFile[], text?: string) {
  if (text === undefined) return "";
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
  return [
    text,
    ...documents.filter((d) => parts.includes(d.path)).map((d) => d.text),
  ].join("\n");
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
    (project.roots.length === 1 ? project.roots[0] : null);
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

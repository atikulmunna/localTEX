import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import {
  indentLess,
  indentMore,
  redo,
  toggleComment,
  undo,
} from "@codemirror/commands";
import {
  Bold,
  Image,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link,
  List,
  ListOrdered,
  MoreHorizontal,
  Percent,
  Quote,
  Redo2,
  Sigma,
  SquareSigma,
  Table,
  Tag,
  Undo2,
} from "lucide-react";
import {
  displayMath,
  headingLevels,
  headingOf,
  insertBlock,
  link,
  makeList,
  reference,
  setHeading,
  toggleWrap,
  type HeadingLevel,
} from "./formatting";

const levelNames: Record<HeadingLevel, string> = {
  chapter: "Chapter",
  section: "Section",
  subsection: "Subsection",
  subsubsection: "Subsubsection",
  paragraph: "Paragraph",
};
interface Tool {
  label: string;
  icon: ReactNode;
  run: (editor: EditorView) => unknown;
  shortcut?: string;
}
// Groups, in the order they give way to the More menu when the pane is narrow.
const groups: Tool[][] = [
  [
    { label: "Undo", icon: <Undo2 size={17} />, run: undo, shortcut: "Ctrl Z" },
    { label: "Redo", icon: <Redo2 size={17} />, run: redo, shortcut: "Ctrl Y" },
  ],
  [
    { label: "Bold", icon: <Bold size={17} />, run: toggleWrap("\\textbf{"), shortcut: "Ctrl B" },
    { label: "Italic", icon: <Italic size={17} />, run: toggleWrap("\\textit{"), shortcut: "Ctrl I" },
  ],
  [
    { label: "Inline math", icon: <Sigma size={17} />, run: toggleWrap("$", "$") },
    { label: "Display math", icon: <SquareSigma size={17} />, run: displayMath },
  ],
  [
    { label: "Bulleted list", icon: <List size={18} />, run: (e) => makeList(e, "itemize") },
    { label: "Numbered list", icon: <ListOrdered size={18} />, run: (e) => makeList(e, "enumerate") },
    { label: "Decrease indent", icon: <IndentDecrease size={17} />, run: indentLess, shortcut: "Shift Tab" },
    { label: "Increase indent", icon: <IndentIncrease size={17} />, run: indentMore, shortcut: "Tab" },
  ],
  [
    { label: "Link", icon: <Link size={17} />, run: link },
    { label: "Cross-reference", icon: <Tag size={16} />, run: (e) => reference(e, "ref") },
    { label: "Citation", icon: <Quote size={16} />, run: (e) => reference(e, "cite") },
  ],
  [
    { label: "Figure", icon: <Image size={17} />, run: (e) => insertBlock(e, "figure") },
    { label: "Table", icon: <Table size={17} />, run: (e) => insertBlock(e, "table") },
  ],
  [{ label: "Comment out", icon: <Percent size={16} />, run: toggleComment, shortcut: "Ctrl /" }],
];
// Approximate widths: a 32px button plus its gap, a divider, the style menu, More.
const buttonWidth = 33;
const dividerWidth = 11;
const fixedWidth = 16 + 140 + dividerWidth + 40;

/** Overleaf-style formatting: select text, click, and the LaTeX is written for you. */
export function EditorToolbar({
  view,
  line,
}: {
  view: () => EditorView | null;
  line: string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const node = bar.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.target instanceof Node && bar.current?.contains(e.target) && e.type !== "keydown")
        return;
      setMenu(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);
  let used = fixedWidth;
  // Undo and Redo always stay; later groups move to the More menu as space runs out.
  const shown = Math.max(
    1,
    groups.filter((group) => {
      used += group.length * buttonWidth + dividerWidth;
      return used <= width;
    }).length,
  );
  const hidden = groups.slice(shown);
  const run = (tool: Tool) => {
    const editor = view();
    setMenu(false);
    if (!editor) return;
    tool.run(editor);
    editor.focus();
  };
  // Buttons keep focus, and with it the selection, in the editor.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const divider = <span className="toolbar-divider" />;
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Formatting" ref={bar}>
      {groups.slice(0, 1).map((group) => group.map(button))}
      {divider}
      <select
        className="style-select"
        aria-label="Text style"
        title="Text style of the current line"
        value={headingOf(line) ?? ""}
        onChange={(e) => {
          const editor = view();
          if (!editor) return;
          setHeading(editor, (e.target.value || null) as HeadingLevel | null);
          editor.focus();
        }}
      >
        <option value="">Normal text</option>
        {headingLevels.map((level) => (
          <option key={level} value={level}>
            {levelNames[level]}
          </option>
        ))}
      </select>
      {groups.slice(1, shown).map((group, i) => (
        <span className="toolbar-group" key={i}>
          {divider}
          {group.map(button)}
        </span>
      ))}
      {hidden.length > 0 && (
        <span className="toolbar-more">
          {divider}
          <button
            className={`icon-button ${menu ? "selected" : ""}`}
            aria-label="More formatting"
            aria-expanded={menu}
            title="More formatting"
            onMouseDown={keepFocus}
            onClick={() => setMenu((open) => !open)}
          >
            <MoreHorizontal size={18} />
          </button>
          {menu && (
            <div className="toolbar-menu" role="menu">
              {hidden.flat().map((tool) => (
                <button
                  key={tool.label}
                  role="menuitem"
                  onMouseDown={keepFocus}
                  onClick={() => run(tool)}
                >
                  {tool.icon}
                  <span>{tool.label}</span>
                  {tool.shortcut && <kbd>{tool.shortcut}</kbd>}
                </button>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  );
  function button(tool: Tool) {
    return (
      <button
        key={tool.label}
        className="icon-button"
        aria-label={tool.label}
        title={tool.shortcut ? `${tool.label} · ${tool.shortcut}` : tool.label}
        onMouseDown={keepFocus}
        onClick={() => run(tool)}
      >
        {tool.icon}
      </button>
    );
  }
}

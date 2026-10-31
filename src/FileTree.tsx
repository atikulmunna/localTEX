import { Fragment, useMemo, useState, type CSSProperties } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Image,
  Pencil,
  Trash2,
} from "lucide-react";
import type { ProjectFile } from "./types";

/** Files the editor shows as a picture or a PDF instead of as text. */
export const previewable = (path: string) =>
  /\.(?:png|jpe?g|gif|svg|webp|bmp|pdf)$/i.test(path);

interface Node {
  name: string;
  path: string;
  folder: boolean;
  file?: ProjectFile;
  children: Node[];
}
function buildTree(files: ProjectFile[], folders: string[]): Node[] {
  const root: Node = { name: "", path: "", folder: true, children: [] };
  const known = new Map<string, Node>([["", root]]);
  const folderNode = (path: string): Node => {
    const existing = known.get(path);
    if (existing) return existing;
    const parts = path.split("/");
    const node: Node = {
      name: parts.at(-1)!,
      path,
      folder: true,
      children: [],
    };
    folderNode(parts.slice(0, -1).join("/")).children.push(node);
    known.set(path, node);
    return node;
  };
  folders.forEach(folderNode);
  for (const file of files) {
    const parts = file.path.split("/");
    folderNode(parts.slice(0, -1).join("/")).children.push({
      name: parts.at(-1)!,
      path: file.path,
      folder: false,
      file,
      children: [],
    });
  }
  // Folders first, then files, in natural order (chapter2 before chapter10).
  const sort = (node: Node) => {
    node.children.sort((a, b) =>
      a.folder !== b.folder
        ? a.folder
          ? -1
          : 1
        : a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}
function Glyph({ path }: { path: string }) {
  if (/\.pdf$/i.test(path)) return <FileText size={15} className="tree-icon" />;
  if (previewable(path)) return <Image size={15} className="tree-icon" />;
  const bib = path.endsWith(".bib");
  return (
    <span className={`file-glyph ${bib ? "bib" : ""}`}>
      {path.endsWith(".tex") ? "T" : bib ? "B" : "·"}
    </span>
  );
}

interface Props {
  files: ProjectFile[];
  folders: string[];
  active: string;
  folder: string;
  isDirty: (path: string) => boolean;
  onOpen: (path: string) => void;
  onSelectFolder: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string, folder: boolean) => void;
}
export function FileTree({
  files,
  folders,
  active,
  folder,
  isDirty,
  onOpen,
  onSelectFolder,
  onRename,
  onDelete,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => buildTree(files, folders), [files, folders]);
  const actions = (path: string, isFolder: boolean) => (
    <span className="row-actions">
      <button
        className="icon-button"
        aria-label={`Rename ${path}`}
        title="Rename"
        onClick={() => onRename(path)}
      >
        <Pencil size={14} />
      </button>
      <button
        className="icon-button"
        aria-label={`Delete ${path}`}
        title="Move to the Recycle Bin"
        onClick={() => onDelete(path, isFolder)}
      >
        <Trash2 size={14} />
      </button>
    </span>
  );
  const render = (nodes: Node[], depth: number) =>
    nodes.map((node) => {
      const style = { "--depth": depth } as CSSProperties;
      if (node.folder) {
        const open = !collapsed.has(node.path);
        return (
          <Fragment key={node.path}>
            <div
              className={`tree-row folder ${folder === node.path ? "selected" : ""}`}
              style={style}
            >
              <button
                className="tree-open"
                aria-expanded={open}
                title={node.path}
                onClick={() => {
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (open) next.add(node.path);
                    else next.delete(node.path);
                    return next;
                  });
                  onSelectFolder(node.path);
                }}
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Folder size={15} className="tree-icon folder-icon" />
                <span className="file-name">{node.name}</span>
              </button>
              {actions(node.path, true)}
            </div>
            {open && render(node.children, depth + 1)}
          </Fragment>
        );
      }
      const usable = node.file?.editable || previewable(node.path);
      return (
        <div
          key={node.path}
          className={`tree-row ${active === node.path ? "active" : ""}`}
          style={style}
        >
          <button
            className="tree-open"
            disabled={!usable}
            title={usable ? node.path : `${node.path} can't be opened here`}
            onClick={() => onOpen(node.path)}
          >
            <Glyph path={node.path} />
            <span className="file-name">{node.name}</span>
            {isDirty(node.path) && <span className="dirty-dot" />}
          </button>
          {actions(node.path, false)}
        </div>
      );
    });
  return <div className="file-tree">{render(tree, 0)}</div>;
}

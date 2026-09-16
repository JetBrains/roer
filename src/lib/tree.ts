/**
 * Changed files as a folder tree.
 *
 * Directories with a single directory inside them are compacted into one row
 * (`src/lib/…`): a repository is mostly deep chains of one child, and a row
 * per empty level is a row you always have to open.
 */
import type { FileChange } from "./git";

export interface DirNode {
  kind: "dir";
  /** What the row shows — several segments when the chain was compacted. */
  name: string;
  /** Full path from the root, which is the collapse key. */
  path: string;
  children: TreeNode[];
}

export interface FileNode {
  kind: "file";
  name: string;
  path: string;
  file: FileChange;
}

export type TreeNode = DirNode | FileNode;

/** A rendered line of the tree. The kind says which half of it is real. */
export type Row =
  | {
      kind: "dir";
      name: string;
      path: string;
      depth: number;
      /** Files under it, so a collapsed row still says how many. */
      count: number;
    }
  | { kind: "file"; name: string; path: string; depth: number; file: FileChange };

interface Building {
  dirs: Map<string, Building>;
  files: FileChange[];
}

const empty = (): Building => ({ dirs: new Map(), files: [] });

export function buildTree(files: readonly FileChange[]): TreeNode[] {
  const root = empty();

  for (const file of files) {
    const segments = file.path.split("/");
    segments.pop(); // the file's own name; it stays in `path`
    let node = root;
    for (const segment of segments) {
      let child = node.dirs.get(segment);
      if (!child) {
        child = empty();
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.push(file);
  }

  return materialise(root, "");
}

function materialise(node: Building, prefix: string): TreeNode[] {
  const dirs: TreeNode[] = [...node.dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, child]) => compact(name, prefix ? `${prefix}/${name}` : name, child));

  const files: TreeNode[] = node.files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({
      kind: "file",
      name: file.path.slice(file.path.lastIndexOf("/") + 1),
      path: file.path,
      file,
    }));

  // Directories first: the shape of the tree reads better than one flat sort.
  return [...dirs, ...files];
}

/** Folds `a` → `b` → files into one `a/b` row. */
function compact(name: string, path: string, node: Building): DirNode {
  if (node.files.length === 0 && node.dirs.size === 1) {
    const [childName, child] = [...node.dirs.entries()][0];
    const folded = compact(childName, `${path}/${childName}`, child);
    return { kind: "dir", name: `${name}/${folded.name}`, path: folded.path, children: folded.children };
  }
  return { kind: "dir", name, path, children: materialise(node, path) };
}

/** The rows to render, in order, with collapsed directories closed. */
export function rows(
  nodes: readonly TreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): Row[] {
  const out: Row[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      out.push({ kind: "file", name: node.name, path: node.path, depth, file: node.file });
      continue;
    }
    out.push({ kind: "dir", name: node.name, path: node.path, depth, count: countFiles([node]) });
    if (!collapsed.has(node.path)) out.push(...rows(node.children, collapsed, depth + 1));
  }
  return out;
}

function countFiles(nodes: readonly TreeNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.kind === "file" ? 1 : countFiles(node.children)),
    0,
  );
}

/**
 * Every file in tree order — the order the arrow keys walk. Collapsing a
 * folder hides rows; it does not take those changes out of the walk, so the
 * keys never skip a change the user has not seen.
 */
export function fileOrder(nodes: readonly TreeNode[]): FileChange[] {
  return nodes.flatMap((node) => (node.kind === "file" ? [node.file] : fileOrder(node.children)));
}

/** Directory paths a file sits under, so navigating into it can open them. */
export function ancestors(path: string): string[] {
  const segments = path.split("/");
  segments.pop();
  return segments.map((_, i) => segments.slice(0, i + 1).join("/"));
}

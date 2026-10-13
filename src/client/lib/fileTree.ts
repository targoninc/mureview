export interface TreeEntry {
  /** Path segments, most general first; the last segment is the file name. */
  segments: string[];
  itemId: string;
}

export interface FileNode<T extends TreeEntry> {
  kind: 'file';
  name: string;
  key: string;
  entry: T;
}

export interface DirNode<T extends TreeEntry> {
  kind: 'dir';
  name: string;
  key: string;
  children: TreeNode<T>[];
  fileIds: string[];
}

export type TreeNode<T extends TreeEntry> = FileNode<T> | DirNode<T>;

export function buildFileTree<T extends TreeEntry>(entries: T[]): TreeNode<T>[] {
  const root: DirNode<T> = { kind: 'dir', name: '', key: '', children: [], fileIds: [] };

  for (const entry of entries) {
    const segments = entry.segments;
    let node = root;
    segments.slice(0, -1).forEach((segment, index) => {
      const key = segments.slice(0, index + 1).join('/');
      let child = node.children.find((candidate): candidate is DirNode<T> => candidate.kind === 'dir' && candidate.key === key);
      if (!child) {
        child = { kind: 'dir', name: segment, key, children: [], fileIds: [] };
        node.children.push(child);
      }
      node = child;
    });
    node.children.push({ kind: 'file', name: segments[segments.length - 1], key: segments.join('/'), entry });
  }

  const assignFileIds = (node: DirNode<T>): string[] => {
    const ids: string[] = [];
    for (const child of node.children) {
      if (child.kind === 'file') ids.push(child.entry.itemId);
      else ids.push(...assignFileIds(child));
    }
    node.fileIds = ids;
    return ids;
  };
  assignFileIds(root);

  const sort = (nodes: TreeNode<T>[]): void => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    for (const node of nodes) if (node.kind === 'dir') sort(node.children);
  };
  sort(root.children);

  return root.children;
}

export function flattenTree<T extends TreeEntry>(nodes: TreeNode<T>[]): T[] {
  const ordered: T[] = [];
  const walk = (list: TreeNode<T>[]) => {
    for (const node of list) {
      if (node.kind === 'file') ordered.push(node.entry);
      else walk(node.children);
    }
  };
  walk(nodes);
  return ordered;
}

export function orderByTree<T extends TreeEntry>(entries: T[]): T[] {
  return flattenTree(buildFileTree(entries));
}

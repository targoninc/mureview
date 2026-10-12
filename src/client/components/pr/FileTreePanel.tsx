import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Checkbox } from '@primer/react';
import { ChevronDownIcon, ChevronRightIcon, FileDirectoryIcon, FileIcon } from '@primer/octicons-react';
import type { FileDiff, FileStatus, PrStatus } from '../../../shared/types';
import { fileItemId, treePath } from '../../lib/format';

interface Entry {
  repo: string;
  path: string;
  itemId: string;
  file: FileDiff;
}

interface FileNode {
  kind: 'file';
  name: string;
  key: string;
  entry: Entry;
}

interface DirNode {
  kind: 'dir';
  name: string;
  key: string;
  children: TreeNode[];
}

type TreeNode = FileNode | DirNode;

const statusLetter: Record<FileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  changed: 'M',
};

const statusClass: Record<FileStatus, string> = {
  added: 'status-added',
  modified: 'status-modified',
  deleted: 'status-deleted',
  renamed: 'status-renamed',
  copied: 'status-renamed',
  changed: 'status-modified',
};

function buildTree(entries: Entry[]): TreeNode[] {
  const root: DirNode = { kind: 'dir', name: '', key: '', children: [] };

  for (const entry of entries) {
    const segments = treePath(entry.repo, entry.path).split('/');
    let node = root;
    segments.slice(0, -1).forEach((segment, index) => {
      const key = segments.slice(0, index + 1).join('/');
      let child = node.children.find((candidate): candidate is DirNode => candidate.kind === 'dir' && candidate.key === key);
      if (!child) {
        child = { kind: 'dir', name: segment, key, children: [] };
        node.children.push(child);
      }
      node = child;
    });
    node.children.push({ kind: 'file', name: segments[segments.length - 1], key: treePath(entry.repo, entry.path), entry });
  }

  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    for (const node of nodes) if (node.kind === 'dir') sort(node.children);
    return nodes;
  };
  return sort(root.children);
}

interface FileTreePanelProps {
  pr: PrStatus;
  reviewedItems: Set<string>;
  onSelectItem: (itemId: string) => void;
  onToggleReviewed: (itemId: string) => void;
}

export function FileTreePanel({ pr, reviewedItems, onSelectItem, onToggleReviewed }: FileTreePanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const entries = useMemo(() => {
    const list: Entry[] = [];
    for (const repo of pr.repos) {
      for (const file of repo.files ?? []) {
        if (!file.patch) continue;
        list.push({ repo: repo.repo, path: file.path, itemId: fileItemId(repo.repo, file.path), file });
      }
    }
    return list;
  }, [pr]);

  const tree = useMemo(() => buildTree(entries), [entries]);

  const toggleDir = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderNodes = (nodes: TreeNode[], depth: number): ReactNode[] =>
    nodes.flatMap((node) => {
      const indent = { paddingLeft: depth * 12 + 8 };
      if (node.kind === 'dir') {
        const isCollapsed = collapsed.has(node.key);
        return [
          <div key={node.key} className="tree-row tree-dir" style={indent} onClick={() => toggleDir(node.key)}>
            <span className="tree-chevron">{isCollapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}</span>
            <span className="tree-icon tree-icon-dir">
              <FileDirectoryIcon size={14} />
            </span>
            <span className="tree-name">{node.name}</span>
          </div>,
          ...(isCollapsed ? [] : renderNodes(node.children, depth + 1)),
        ];
      }

      const { file } = node.entry;
      const isReviewed = reviewedItems.has(node.entry.itemId);
      return [
        <div
          key={node.key}
          className={`tree-row tree-file${selected === node.entry.itemId ? ' selected' : ''}`}
          style={indent}
          onClick={() => {
            setSelected(node.entry.itemId);
            onSelectItem(node.entry.itemId);
          }}
        >
          <span className="tree-checkbox" onClick={(event) => event.stopPropagation()}>
            <Checkbox checked={isReviewed} onChange={() => onToggleReviewed(node.entry.itemId)} aria-label={`Mark ${node.name} as reviewed`} />
          </span>
          <span className="tree-icon">
            <FileIcon size={14} />
          </span>
          <span className="tree-name">{node.name}</span>
          <span className="tree-stats">
            {file.additions > 0 ? <span className="additions">+{file.additions}</span> : null}
            {file.deletions > 0 ? <span className="deletions">−{file.deletions}</span> : null}
            <span className={statusClass[file.type]} title={`${file.type} file`}>
              {statusLetter[file.type]}
            </span>
          </span>
        </div>,
      ];
    });

  return <div className="tree">{renderNodes(tree, 0)}</div>;
}

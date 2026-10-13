import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Checkbox } from '@primer/react';
import { ChevronDownIcon, ChevronRightIcon, FileDirectoryIcon, FileIcon } from '@primer/octicons-react';
import type { FileDiff, FileStatus, PrStatus } from '../../../shared/types';
import { buildFileTree, type TreeEntry, type TreeNode } from '../../lib/fileTree';
import { fileItemId, treePathFor } from '../../lib/format';

interface Entry extends TreeEntry {
  file: FileDiff;
}

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

interface FileTreePanelProps {
  pr: PrStatus;
  reviewedItems: Set<string>;
  visibleItems: Set<string>;
  onSelectItem: (itemId: string) => void;
  /** Omitted for review sets owned by other users, which are read-only. */
  onSetReviewed?: (itemIds: string[], reviewed: boolean) => void;
}

export function FileTreePanel({ pr, reviewedItems, visibleItems, onSelectItem, onSetReviewed }: FileTreePanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const entries = useMemo(() => {
    const list: Entry[] = [];
    for (const repo of pr.repos) {
      for (const file of repo.files ?? []) {
        if (!file.patch) continue;
        list.push({
          treePath: treePathFor(repo.host, repo.repo, file.path),
          itemId: fileItemId(repo.connectionId, repo.repo, file.path),
          file,
        });
      }
    }
    return list;
  }, [pr]);

  const tree = useMemo(() => buildFileTree(entries), [entries]);

  const toggleDir = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderNodes = (nodes: TreeNode<Entry>[], depth: number): ReactNode[] =>
    nodes.flatMap((node) => {
      const indent = { paddingLeft: depth * 12 + 8 };
      if (node.kind === 'dir') {
        const isCollapsed = collapsed.has(node.key);
        const allReviewed = node.fileIds.length > 0 && node.fileIds.every((id) => reviewedItems.has(id));
        const someReviewed = !allReviewed && node.fileIds.some((id) => reviewedItems.has(id));
        return [
          <div key={node.key} className="tree-row tree-dir" style={indent} onClick={() => toggleDir(node.key)}>
            {onSetReviewed ? (
              <span className="tree-checkbox" onClick={(event) => event.stopPropagation()}>
                <Checkbox
                  checked={allReviewed}
                  indeterminate={someReviewed}
                  onChange={() => onSetReviewed(node.fileIds, !allReviewed)}
                  aria-label={`Mark ${node.name} as reviewed`}
                />
              </span>
            ) : null}
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
          className={`tree-row tree-file${visibleItems.has(node.entry.itemId) ? ' visible' : ''}${selected === node.entry.itemId ? ' selected' : ''}`}
          style={indent}
          onClick={() => {
            setSelected(node.entry.itemId);
            onSelectItem(node.entry.itemId);
          }}
        >
          <span className="tree-checkbox" onClick={(event) => event.stopPropagation()}>
            {onSetReviewed ? (
              <Checkbox
                checked={isReviewed}
                onChange={() => onSetReviewed([node.entry.itemId], !isReviewed)}
                aria-label={`Mark ${node.name} as reviewed`}
              />
            ) : null}
          </span>
          <span className="tree-chevron" />
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

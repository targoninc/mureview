import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Checkbox } from '@primer/react';
import { ChevronDownIcon, ChevronRightIcon, FileDirectoryIcon } from '@primer/octicons-react';
import type { FileDiff, FileStatus, ForgeKind, PrStatus, RepoStatus } from '../../../shared/types';
import { buildFileTree, type TreeEntry, type TreeNode } from '../../lib/fileTree';
import { fileItemId, fileSegments } from '../../lib/format';
import { ServiceGlyph } from '../ServiceIcon';
import { fileIconFor, ensureFileIconSprite } from '../../lib/fileIcons';

interface Entry extends TreeEntry {
  file: FileDiff;
  path: string;
}

/** The file's icon from the colored Pierre set (the one T3 Code uses). */
function FileIcon({ path, size = 14 }: { path: string; size?: number }) {
  const icon = fileIconFor(path);
  return (
    <svg width={size} height={size} fill="currentColor" style={{ color: icon.color }} aria-hidden="true">
      <use href={`#${icon.name}`} />
    </svg>
  );
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
  /** The repository entries to show: layers, or the cumulative diff. */
  entries: RepoStatus[];
  /** Whether the entries are layers of stacks. */
  stacked: boolean;
  reviewedItems: Set<string>;
  visibleItems: Set<string>;
  onSelectItem: (itemId: string) => void;
  /** Sets the viewed mark; everyone keeps their own marks, also on shared sets. */
  onSetReviewed?: (itemIds: string[], reviewed: boolean) => void;
}

export function FileTreePanel({ pr, entries, stacked, reviewedItems, visibleItems, onSelectItem, onSetReviewed }: FileTreePanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    ensureFileIconSprite();
  }, []);

  const entriesForTree = useMemo(() => {
    const list: Entry[] = [];
    for (const repo of entries) {
      const layer = stacked && repo.position >= 0 ? `Layer ${repo.position + 1} · ${repo.branch}` : undefined;
      for (const file of repo.files ?? []) {
        if (!file.patch) continue;
        list.push({
          segments: fileSegments(repo.host, repo.repo, file.path, layer),
          itemId: fileItemId(repo.connectionId, repo.repo, repo.position, file.path),
          file,
          path: file.path,
        });
      }
    }
    return list;
  }, [entries, stacked]);

  const repoKinds = useMemo(
    () => new Map<string, ForgeKind>(entries.map((repo) => [`${repo.host}/${repo.repo}`, repo.kind])),
    [entries],
  );

  const tree = useMemo(() => buildFileTree(entriesForTree), [entriesForTree]);

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
        const repoKind = repoKinds.get(node.key);
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
            <span className={`tree-icon ${repoKind ? 'tree-icon-repo' : 'tree-icon-dir'}`}>
              {repoKind ? <ServiceGlyph kind={repoKind} size={14} /> : <FileDirectoryIcon size={14} />}
            </span>
            <span className="tree-name" title={node.name}>
              {node.name}
            </span>
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
              <FileIcon path={node.entry.path} />
            </span>
          <span className="tree-name" title={node.entry.path}>
            {node.name}
          </span>
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

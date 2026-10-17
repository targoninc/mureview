import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Checkbox } from '@primer/react';
import { ChevronDownIcon, ChevronRightIcon, CommentDiscussionIcon, FileDirectoryIcon } from '@primer/octicons-react';
import type { FileDiff, FileStatus, ForgeKind, PrStatus, RepoStatus } from '../../../shared/types';
import { buildFileTree, type TreeEntry, type TreeNode } from '../../lib/fileTree';
import { fileItemId, fileSegments, repoItemKey } from '../../lib/format';
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
  /** Item ids left out of the tree; viewed files, when the user hides them. */
  hiddenItems?: Set<string>;
  visibleItems: Set<string>;
  /** The file open in the single file view; scrolled into view when it changes. */
  focusedItemId?: string | null;
  /** Comments per file item, shown as an icon with a count. */
  commentCounts?: Map<string, number>;
  onSelectItem: (itemId: string) => void;
  /** Sets the viewed mark; everyone keeps their own marks, also on shared sets. */
  onSetReviewed?: (itemIds: string[], reviewed: boolean) => void;
}

export function FileTreePanel({
  pr,
  entries,
  stacked,
  reviewedItems,
  hiddenItems,
  visibleItems,
  focusedItemId,
  commentCounts,
  onSelectItem,
  onSetReviewed,
}: FileTreePanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureFileIconSprite();
  }, []);

  const entriesForTree = useMemo(() => {
    const list: Entry[] = [];
    for (const repo of entries) {
      const layer = stacked && repo.position >= 0 ? `Layer ${repo.position + 1} · ${repo.branch}` : undefined;
      for (const file of repo.files ?? []) {
        if (!file.patch) continue;
        const itemId = fileItemId(repo.connectionId, repo.repo, repo.position, file.path);
        if (hiddenItems?.has(itemId)) continue;
        list.push({
          segments: fileSegments(repo.host, repo.repo, file.path, layer),
          itemId,
          file,
          path: file.path,
        });
      }
    }
    return list;
  }, [entries, stacked, hiddenItems]);

  const repoKinds = useMemo(
    () => new Map<string, ForgeKind>(entries.map((repo) => [repoItemKey(repo), repo.kind])),
    [entries],
  );

  const tree = useMemo(() => buildFileTree(entriesForTree), [entriesForTree]);
  const treeKey = useMemo(
    () => entries.map((repo) => `${repo.position}:${repo.repo}:${repo.branch ?? ''}:${(repo.files ?? []).length}`).join('|'),
    [entries],
  );

  // Opening a file in the single file view expands the directories on the way
  // to it.
  useEffect(() => {
    if (!focusedItemId) return;
    const ancestors: string[] = [];
    const walk = (nodes: TreeNode<Entry>[], path: string[]): boolean => {
      for (const node of nodes) {
        if (node.kind === 'file') {
          if (node.entry.itemId === focusedItemId) {
            ancestors.push(...path);
            return true;
          }
          continue;
        }
        if (walk(node.children, [...path, node.key])) return true;
      }
      return false;
    };
    walk(tree, []);
    if (ancestors.length === 0) return;
    setCollapsed((current) => {
      const next = new Set(current);
      let changed = false;
      for (const key of ancestors) if (next.delete(key)) changed = true;
      return changed ? next : current;
    });
  }, [focusedItemId, tree]);

  // Scroll the row into sight after the tree renders. The retries cover the
  // rows that directories expanded for this file add above it.
  useLayoutEffect(() => {
    if (!focusedItemId) return;
    const scrollToRow = () => {
      const row = treeRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(focusedItemId)}"]`);
      if (!row) return;
      let scroll: HTMLElement | null = treeRef.current?.parentElement ?? null;
      while (scroll && !/(auto|scroll)/.test(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
      if (!scroll) return;
      const view = scroll.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      if (rect.top < view.top) scroll.scrollTop += rect.top - view.top - 8;
      else if (rect.bottom > view.bottom) scroll.scrollTop += rect.bottom - view.bottom + 8;
    };
    scrollToRow();
    const timers = [150, 400].map((delay) => window.setTimeout(scrollToRow, delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [focusedItemId, collapsed]);

  const toggleDir = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const selectItem = useCallback(
    (itemId: string) => {
      setSelected(itemId);
      onSelectItem(itemId);
    },
    [onSelectItem],
  );

  // The visible rows as one flat list: React reconciles a single keyed array
  // reliably, and the tree is virtualized by the browser anyway.
  const rows = useMemo(() => {
    const list: Array<{ node: TreeNode<Entry>; depth: number }> = [];
    const walk = (nodes: TreeNode<Entry>[], depth: number) => {
      for (const node of nodes) {
        list.push({ node, depth });
        if (node.kind === 'dir' && !collapsed.has(node.key)) walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return list;
  }, [tree, collapsed]);

  const renderRow = ({ node, depth }: { node: TreeNode<Entry>; depth: number }) => {
    const indent = { paddingLeft: depth * 12 + 8 };
    if (node.kind === 'dir') {
      const isCollapsed = collapsed.has(node.key);
      const allReviewed = node.fileIds.length > 0 && node.fileIds.every((id) => reviewedItems.has(id));
      const someReviewed = !allReviewed && node.fileIds.some((id) => reviewedItems.has(id));
      const repoKind = repoKinds.get(node.key);
      return (
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
        </div>
      );
    }

    const entry = node.entry;
    return (
      <TreeFileRow
        key={node.key}
        itemId={entry.itemId}
        name={node.name}
        path={entry.path}
        file={entry.file}
        depth={depth}
        reviewed={reviewedItems.has(entry.itemId)}
        visible={visibleItems.has(entry.itemId)}
        comments={commentCounts?.get(entry.itemId) ?? 0}
        selected={focusedItemId ? focusedItemId === entry.itemId : selected === entry.itemId}
        canReview={Boolean(onSetReviewed)}
        onSelect={selectItem}
        onReviewed={onSetReviewed}
      />
    );
  };

  return (
    <div className="tree" key={treeKey} ref={treeRef}>
      {rows.map(renderRow)}
    </div>
  );
}

/**
 * A file row is memoized: the visible set changes on every scroll frame while
 * a diff is read, and re-rendering every row of a large tree each time is what
 * made scrolling feel laggy.
 */
const TreeFileRow = memo(function TreeFileRow({
  itemId,
  name,
  path,
  file,
  depth,
  reviewed,
  visible,
  comments,
  selected,
  canReview,
  onSelect,
  onReviewed,
}: {
  itemId: string;
  name: string;
  path: string;
  file: FileDiff;
  depth: number;
  reviewed: boolean;
  visible: boolean;
  comments: number;
  selected: boolean;
  canReview: boolean;
  onSelect: (itemId: string) => void;
  onReviewed?: (itemIds: string[], reviewed: boolean) => void;
}) {
  return (
    <div
      className={`tree-row tree-file${visible ? ' visible' : ''}${selected ? ' selected' : ''}`}
      data-item-id={itemId}
      style={{ paddingLeft: depth * 12 + 8 }}
      onClick={() => onSelect(itemId)}
    >
      <span className="tree-checkbox" onClick={(event) => event.stopPropagation()}>
        {canReview && onReviewed ? (
          <Checkbox checked={reviewed} onChange={() => onReviewed([itemId], !reviewed)} aria-label={`Mark ${name} as reviewed`} />
        ) : null}
      </span>
      <span className="tree-chevron" />
      <span className="tree-icon">
        <FileIcon path={path} />
      </span>
      <span className="tree-name" title={path}>
        {name}
      </span>
      <span className="tree-stats">
        {comments > 0 ? (
          <span className="tree-comments" title={`${comments} ${comments === 1 ? 'comment' : 'comments'}`}>
            <CommentDiscussionIcon size={12} />
            {comments}
          </span>
        ) : null}
        {file.additions > 0 ? <span className="additions">+{file.additions}</span> : null}
        {file.deletions > 0 ? <span className="deletions">−{file.deletions}</span> : null}
        <span className={statusClass[file.type]} title={`${file.type} file`}>
          {statusLetter[file.type]}
        </span>
      </span>
    </div>
  );
});

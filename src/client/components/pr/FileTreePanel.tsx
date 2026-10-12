import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { GitStatus, GitStatusEntry } from '@pierre/trees';
import type { FileStatus, PrStatus } from '../../../shared/types';
import { fileItemId, treePath } from '../../lib/format';

const statusMap: Record<FileStatus, GitStatus> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  modified: 'modified',
  copied: 'modified',
  changed: 'modified',
};

const treeTheme = {
  '--trees-theme-sidebar-bg': 'transparent',
  '--trees-theme-sidebar-fg': 'var(--fgColor-default)',
  '--trees-theme-sidebar-border': 'var(--borderColor-default)',
  '--trees-theme-sidebar-header-fg': 'var(--fgColor-muted)',
  '--trees-theme-list-hover-bg': 'var(--control-transparent-bgColor-hover)',
  '--trees-theme-list-active-selection-bg': 'var(--bgColor-accent-muted)',
  '--trees-theme-list-active-selection-fg': 'var(--fgColor-default)',
  '--trees-theme-git-added-fg': 'var(--fgColor-success)',
  '--trees-theme-git-deleted-fg': 'var(--fgColor-danger)',
  '--trees-theme-git-modified-fg': 'var(--fgColor-attention)',
  '--trees-theme-input-bg': 'var(--bgColor-default)',
  '--trees-theme-input-border': 'var(--borderColor-default)',
  '--trees-theme-focus-ring': 'var(--focus-outlineColor)',
  '--trees-theme-scrollbar-thumb': 'var(--borderColor-muted)',
} as CSSProperties;

const composition = { contextMenu: { enabled: true, triggerMode: 'right-click' as const } };

interface FileTreePanelProps {
  pr: PrStatus;
  reviewedItems: Set<string>;
  onSelectItem: (itemId: string) => void;
  onToggleReviewed: (itemId: string) => void;
}

export function FileTreePanel({ pr, reviewedItems, onSelectItem, onToggleReviewed }: FileTreePanelProps) {
  const entries = useMemo(() => {
    const list: { treePath: string; itemId: string; status: GitStatus }[] = [];
    for (const repo of pr.repos) {
      for (const file of repo.files ?? []) {
        if (!file.patch) continue;
        list.push({ treePath: treePath(repo.repo, file.path), itemId: fileItemId(repo.repo, file.path), status: statusMap[file.type] });
      }
    }
    return list;
  }, [pr]);

  const itemIdByTreePath = useMemo(() => new Map(entries.map((entry) => [entry.treePath, entry.itemId])), [entries]);
  const itemIdRef = useRef(itemIdByTreePath);
  itemIdRef.current = itemIdByTreePath;
  const reviewedRef = useRef(reviewedItems);
  reviewedRef.current = reviewedItems;
  const toggleRef = useRef(onToggleReviewed);
  toggleRef.current = onToggleReviewed;

  const paths = useMemo(() => entries.map((entry) => entry.treePath), [entries]);
  const gitStatus = useMemo<GitStatusEntry[]>(() => entries.map((entry) => ({ path: entry.treePath, status: entry.status })), [entries]);
  const reviewedKey = useMemo(() => [...reviewedItems].sort().join('|'), [reviewedItems]);

  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion: 'open',
    density: 'compact',
    composition,
    renderRowDecoration: (context) => {
      const itemId = itemIdRef.current.get(context.row.path);
      if (!itemId || !reviewedRef.current.has(itemId)) return null;
      return { parts: [{ text: '✓', color: 'var(--fgColor-success)' }], text: '✓', title: 'Reviewed' };
    },
    onSelectionChange: (selected) => {
      const first = selected[0];
      const itemId = first ? itemIdRef.current.get(first) : undefined;
      if (itemId) onSelectItem(itemId);
    },
  });

  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(gitStatus);
  }, [model, paths, gitStatus]);

  useEffect(() => {
    // Row decorations are captured at creation time; toggling the icon surface
    // repaints the rows with the current reviewed state without disturbing the
    // context-menu composition managed by the React wrapper.
    model.setIcons(undefined);
  }, [model, reviewedKey]);

  return (
    <FileTree
      model={model}
      className="file-tree-host"
      style={treeTheme}
      renderContextMenu={(item, context) => {
        if (item.kind !== 'file') return null;
        const itemId = itemIdRef.current.get(item.path);
        if (!itemId) return null;
        return (
          <div className="tree-menu">
            <button
              type="button"
              className="tree-menu-item"
              onClick={() => {
                context.close({ restoreFocus: false });
                toggleRef.current(itemId);
              }}
            >
              {reviewedRef.current.has(itemId) ? 'Mark as not reviewed' : 'Mark as reviewed'}
            </button>
          </div>
        );
      }}
    />
  );
}

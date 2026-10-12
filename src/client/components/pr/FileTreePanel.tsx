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

export function FileTreePanel({ pr, onSelectItem }: { pr: PrStatus; onSelectItem: (itemId: string) => void }) {
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

  const paths = useMemo(() => entries.map((entry) => entry.treePath), [entries]);
  const gitStatus = useMemo<GitStatusEntry[]>(() => entries.map((entry) => ({ path: entry.treePath, status: entry.status })), [entries]);

  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion: 'open',
    density: 'compact',
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

  return <FileTree model={model} className="file-tree-host" style={treeTheme} />;
}

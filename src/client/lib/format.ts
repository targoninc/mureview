import type { FileStatus, RepoStatus } from '../../shared/types';

export function timeAgo(iso: string): string {
  const normalized = iso.includes('T') || iso.endsWith('Z') ? iso : `${iso.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function repoLabel(status: RepoStatus): string {
  if (status.state === 'error') return 'error';
  if (status.state === 'merged') return 'merged';
  if (status.state === 'open') return `${status.files?.length ?? 0} files`;
  if (status.matches.length > 1) return `${status.matches.length} matching branches`;
  if (status.branch) return 'merged';
  return 'no matching branch';
}

export function fileStatusTone(status: FileStatus): 'success' | 'danger' | 'attention' | 'done' | 'accent' {
  switch (status) {
    case 'added':
      return 'success';
    case 'deleted':
      return 'danger';
    case 'renamed':
      return 'attention';
    default:
      return 'accent';
  }
}

export function fileItemId(repo: string, path: string): string {
  return `${repo}:${path}`;
}

export function treePath(repo: string, path: string): string {
  return `${repo}/${path}`;
}

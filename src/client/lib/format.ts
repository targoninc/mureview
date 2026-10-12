import type { RepoStatus } from '../../shared/types';

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

export function fileItemId(connectionId: number, repo: string, path: string): string {
  return `${connectionId}:${repo}:${path}`;
}

export function treePathFor(host: string, repo: string, path: string): string {
  return `${host}/${repo}/${path}`;
}

export function repoLabelOf(repo: Pick<RepoStatus, 'host' | 'repo'>): string {
  return `${repo.host}/${repo.repo}`;
}

export function repoStatusText(status: RepoStatus): string {
  if (status.state === 'error') return 'error';
  if (status.state === 'merged') return 'merged';
  if (status.state === 'open') return `${status.files?.length ?? 0} files`;
  if (status.matches.length > 1) return `${status.matches.length} matching branches`;
  if (status.branch) return 'merged';
  return 'no matching branch';
}

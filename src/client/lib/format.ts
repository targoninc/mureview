import type { Comment, ForgeKind, RepoStatus } from '../../shared/types';

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

/** Tree segments for a changed file, keeping "owner/name" repositories atomic. */
export function fileSegments(host: string, repo: string, path: string): string[] {
  return [host, repo, ...path.split('/')];
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

/** Deep link to a comment on its forge pull request, when one exists. */
export function forgeCommentLink(repos: RepoStatus[], comment: Comment): { url: string; kind: ForgeKind } | null {
  const id = comment.forgeCommentId;
  if (!id || comment.connectionId === null || !comment.repo) return null;
  const repo = repos.find((entry) => entry.connectionId === comment.connectionId && entry.repo === comment.repo);
  const pull = repo?.pullRequest;
  if (!repo || !pull) return null;
  const anchored = comment.path !== null;
  if (repo.kind === 'github') return { url: `${pull.url}#${anchored ? 'discussion_r' : 'issuecomment-'}${id}`, kind: repo.kind };
  if (repo.kind === 'forgejo') return { url: `${pull.url}${anchored ? '/files' : ''}#issuecomment-${id}`, kind: repo.kind };
  const threadId = id.split(':')[0];
  return { url: `${pull.url}?discussionId=${threadId}&_a=${anchored ? 'files' : 'discussion'}`, kind: repo.kind };
}

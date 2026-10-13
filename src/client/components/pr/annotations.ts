import type { Comment } from '../../../shared/types';
import { fileItemId } from '../../lib/format';

export type Side = 'additions' | 'deletions';

export interface ThreadMeta {
  threadKey: string;
  connectionId: number;
  repo: string;
  position: number;
  path: string;
  side: Side;
  line: number;
  comments: Comment[];
}

export interface DraftMeta extends Omit<ThreadMeta, 'comments'> {
  draft: true;
  comments: Comment[];
}

export type AnnotationMeta = ThreadMeta | DraftMeta;

export function isDraft(meta: AnnotationMeta): meta is DraftMeta {
  return 'draft' in meta && meta.draft === true;
}

export function groupThreads(comments: Comment[]): Map<string, ThreadMeta[]> {
  const byItem = new Map<string, Map<string, Comment[]>>();
  for (const comment of comments) {
    if (comment.connectionId === null || !comment.repo || !comment.path || !comment.line || !comment.side) continue;
    const itemId = fileItemId(comment.connectionId, comment.repo, comment.position, comment.path);
    const threadKey = `${comment.side}:${comment.line}`;
    const threads = byItem.get(itemId) ?? new Map<string, Comment[]>();
    threads.set(threadKey, [...(threads.get(threadKey) ?? []), comment]);
    byItem.set(itemId, threads);
  }

  const result = new Map<string, ThreadMeta[]>();
  for (const [itemId, threads] of byItem) {
    result.set(
      itemId,
      [...threads.entries()].map(([threadKey, list]) => ({
        threadKey: `${itemId}:${threadKey}`,
        connectionId: list[0].connectionId!,
        repo: list[0].repo!,
        position: list[0].position,
        path: list[0].path!,
        side: list[0].side!,
        line: list[0].line!,
        comments: list,
      })),
    );
  }
  return result;
}

export function threadVersion(threads: ThreadMeta[], draftItemId: string | null, itemId: string): number {
  let version = 1;
  for (const thread of threads) version = version * 31 + thread.comments.length + (thread.comments.at(-1)?.id ?? 0);
  if (draftItemId === itemId) version += 1_000_003;
  return version;
}

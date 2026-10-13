import type { RepoStatus } from '../shared/types';
import { mapLimit } from './cache';
import { db } from './db';
import type { ForgeClient, ForgeComment } from './forges';

interface ExistingRow {
  id: number;
  forge_comment_id: string | null;
  body: string;
  path: string | null;
  line: number | null;
}

function normalizeDate(value: string): string {
  const date = new Date(value);
  const iso = Number.isNaN(date.getTime()) ? new Date() : date;
  return iso.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Imports comments that exist on the forge pull requests (written by anyone,
 * including replies) into mureview. Comments mureview posted are recognised by
 * their stored forge comment id; for forges that do not report ids the body and
 * anchor are used as a fallback.
 */
export async function syncForgeComments(prId: number, clients: Map<number, ForgeClient>, repos: RepoStatus[]): Promise<void> {
  const open = repos.filter((repo) => repo.state === 'open' && repo.pullRequest);
  await mapLimit(open, 3, async (repo) => {
    const client = clients.get(repo.connectionId);
    if (!client || !repo.pullRequest) return;

    let forgeComments: ForgeComment[];
    try {
      forgeComments = await client.listComments(repo.repo, repo.pullRequest.number);
    } catch (error) {
      console.error(`Could not read comments for ${repo.host}/${repo.repo}:`, error);
      return;
    }

    const existing = db
      .query<ExistingRow, [number, number, string]>(
        'SELECT id, forge_comment_id, body, path, line FROM comments WHERE pr_id = ? AND connection_id = ? AND repo = ?',
      )
      .all(prId, repo.connectionId, repo.repo);
    const knownIds = new Set(existing.map((row) => row.forge_comment_id).filter((id): id is string => Boolean(id)));
    const anchors = new Map<string, { path: string; line: number; side: 'additions' | 'deletions' }>();
    for (const comment of forgeComments) {
      if (comment.path && comment.line) anchors.set(comment.id, { path: comment.path, line: comment.line, side: comment.side ?? 'additions' });
    }

    for (const comment of forgeComments) {
      if (knownIds.has(comment.id)) continue;
      const duplicate = existing.find(
        (row) => row.path === (comment.path ?? null) && row.line === (comment.line ?? null) && row.body.trim() === comment.body.trim(),
      );
      if (duplicate) continue;

      let anchor = comment.path && comment.line ? { path: comment.path, line: comment.line, side: comment.side ?? 'additions' } : null;
      if (!anchor && comment.replyToId) anchor = anchors.get(comment.replyToId) ?? null;

      db.run(
        `INSERT INTO comments (pr_id, author_id, author_name, author_avatar, connection_id, repo, path, line, side, body, synced_at, forge_comment_id, source, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 'forge', ?)`,
        [
          prId,
          comment.author.name,
          comment.author.avatarUrl,
          repo.connectionId,
          repo.repo,
          anchor?.path ?? null,
          anchor?.line ?? null,
          anchor?.side ?? null,
          comment.body,
          comment.id,
          normalizeDate(comment.createdAt),
        ],
      );
    }
  });
}

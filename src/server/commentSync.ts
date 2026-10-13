import { mapLimit } from './cache';
import { db } from './db';
import type { ForgeClient, ForgeComment } from './forges';

interface ExistingRow {
  id: number;
  forge_comment_id: string | null;
  body: string;
  path: string | null;
  line: number | null;
  author_name: string;
  author_avatar: string;
}

function normalizeDate(value: string): string {
  const date = new Date(value);
  const iso = Number.isNaN(date.getTime()) ? new Date() : date;
  return iso.toISOString().slice(0, 19).replace('T', ' ');
}

export interface SyncTarget {
  connectionId: number;
  repo: string;
  pullRequestNumber: number;
}

const lastSyncByPr = new Map<number, number>();
const syncIntervalMs = 30_000;

/**
 * Imports comments that exist on the forge pull requests (written by anyone,
 * including replies) into mureview. Comments mureview posted are recognised by
 * their stored forge comment id; for forges that do not report ids the body and
 * anchor are used as a fallback. Syncing is throttled so loading a review set
 * does not hit every forge on every request.
 */
export async function syncForgeComments(prId: number, clients: Map<number, ForgeClient>, targets: SyncTarget[], force = false): Promise<void> {
  const last = lastSyncByPr.get(prId) ?? 0;
  if (!force && Date.now() - last < syncIntervalMs) return;
  lastSyncByPr.set(prId, Date.now());

  await mapLimit(targets, 3, async (target) => {
    const client = clients.get(target.connectionId);
    if (!client) return;
    const repo = { connectionId: target.connectionId, repo: target.repo };

    let forgeComments: ForgeComment[];
    try {
      forgeComments = await client.listComments(repo.repo, target.pullRequestNumber);
    } catch (error) {
      console.error(`Could not read comments for ${repo.repo}:`, error);
      return;
    }

    const existing = db
      .query<ExistingRow, [number, number, string]>(
        'SELECT id, forge_comment_id, body, path, line, author_name, author_avatar FROM comments WHERE pr_id = ? AND connection_id = ? AND repo = ?',
      )
      .all(prId, repo.connectionId, repo.repo);
    const knownIds = new Set(existing.map((row) => row.forge_comment_id).filter((id): id is string => Boolean(id)));
    const byForgeId = new Map(existing.filter((row) => row.forge_comment_id).map((row) => [row.forge_comment_id!, row]));
    const anchors = new Map<string, { path: string; line: number; side: 'additions' | 'deletions' }>();
    for (const comment of forgeComments) {
      if (comment.path && comment.line) anchors.set(comment.id, { path: comment.path, line: comment.line, side: comment.side ?? 'additions' });
    }

    // Comments that already exist may have been imported before their author
    // details were available; fill in an avatar (and name) once the forge
    // reports one.
    const fillAuthor = (row: ExistingRow, comment: ForgeComment) => {
      if (row.author_avatar || !comment.author.avatarUrl) return;
      db.run('UPDATE comments SET author_avatar = ?, author_name = COALESCE(NULLIF(author_name, \'\'), ?) WHERE id = ?', [
        comment.author.avatarUrl,
        comment.author.name,
        row.id,
      ]);
    };

    // For comments that exist on the forge, the forge account is the author
    // to show; this also repairs rows stored before that was the case.
    const applyForgeAuthor = (row: ExistingRow, comment: ForgeComment) => {
      const name = comment.author.name && comment.author.name !== 'unknown' ? comment.author.name : null;
      const avatar = comment.author.avatarUrl || null;
      if (!name && !avatar) return;
      if (row.author_name === (name ?? row.author_name) && row.author_avatar === (avatar ?? row.author_avatar)) return;
      db.run('UPDATE comments SET author_name = COALESCE(?, author_name), author_avatar = COALESCE(?, author_avatar) WHERE id = ?', [
        name,
        avatar,
        row.id,
      ]);
    };

    for (const comment of forgeComments) {
      if (knownIds.has(comment.id)) {
        const known = byForgeId.get(comment.id);
        if (known) applyForgeAuthor(known, comment);
        continue;
      }
      const duplicate = existing.find(
        (row) => row.path === (comment.path ?? null) && row.line === (comment.line ?? null) && row.body.trim() === comment.body.trim(),
      );
      if (duplicate) {
        fillAuthor(duplicate, comment);
        continue;
      }

      let anchor = comment.path && comment.line ? { path: comment.path, line: comment.line, side: comment.side ?? 'additions' } : null;
      if (!anchor && comment.replyToId) anchor = anchors.get(comment.replyToId) ?? null;
      const parent = comment.replyToId ? byForgeId.get(comment.replyToId) : undefined;

      const inserted = db.run(
        `INSERT INTO comments (pr_id, author_id, author_name, author_avatar, connection_id, repo, path, line, side, body, synced_at, forge_comment_id, parent_id, source, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, 'forge', ?)`,
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
          parent?.id ?? null,
          normalizeDate(comment.createdAt),
        ],
      );
      const row: ExistingRow = {
        id: Number(inserted.lastInsertRowid),
        forge_comment_id: comment.id,
        body: comment.body,
        path: comment.path ?? null,
        line: comment.line ?? null,
        author_name: comment.author.name,
        author_avatar: comment.author.avatarUrl,
      };
      byForgeId.set(comment.id, row);
    }
  });
}

import type { ForgeKind } from '../shared/types';
import { connectionsFor } from './auth/identities';
import { Cache } from './cache';
import { db } from './db';
import { clientFor, hostOf, organizationOf } from './forges';
import { HttpError } from './http';

export interface ReviewSetRow {
  id: number;
  owner_id: number;
  name: string;
  mode: string;
  branch_regex: string;
  target_branch: string;
  created_at: string;
}

export interface OwnerInfo {
  name: string;
  avatarUrl: string;
}

export function ownerInfo(ownerId: number): OwnerInfo | null {
  const row = db
    .query<{ name: string; avatar_url: string }, [number]>('SELECT name, avatar_url FROM users WHERE id = ?')
    .get(ownerId);
  return row ? { name: row.name || 'someone', avatarUrl: row.avatar_url } : null;
}

export function reviewSetRow(id: number): ReviewSetRow | null {
  return db.query<ReviewSetRow, [number]>('SELECT * FROM review_sets WHERE id = ?').get(id) ?? null;
}

export interface AccessibleRepo {
  kind: ForgeKind;
  host: string;
  org: string | null;
  repo: string;
}

const accessCache = new Cache<boolean>(1000, 5 * 60_000);

/**
 * A review set is readable by another user when they can reach every one of
 * its repositories with a connection of their own. The checks are done with
 * their own credentials, so an inaccessible repository hides the whole set.
 */
export async function reposAccessible(userId: number, repos: AccessibleRepo[]): Promise<boolean> {
  if (!repos.length) return false;
  const connections = connectionsFor(userId);
  for (const repo of repos) {
    const connection = connections.find(
      (candidate) =>
        candidate.kind === repo.kind &&
        hostOf(candidate.base_url) === repo.host &&
        (repo.kind !== 'ado' || organizationOf(candidate.base_url) === repo.org),
    );
    if (!connection) return false;
    const key = `${userId}#${connection.id}#${repo.repo}`;
    if (accessCache.get(key)) continue;
    try {
      await clientFor(connection).ensureRepo(repo.repo, { fresh: true });
    } catch {
      return false;
    }
    accessCache.set(key, true);
  }
  return true;
}

export interface ReadableReviewSetRow {
  row: ReviewSetRow;
  owned: boolean;
  owner: OwnerInfo | null;
}

export async function loadReadableReviewSetRow(userId: number, id: number): Promise<ReadableReviewSetRow> {
  const row = reviewSetRow(id);
  if (!row) throw new HttpError(404, 'Review set not found');
  if (row.owner_id === userId) return { row, owned: true, owner: ownerInfo(row.owner_id) };
  const repos = db
    .query<{ kind: ForgeKind; base_url: string; repo: string }, [number]>(
      `SELECT fc.kind, fc.base_url, rsr.repo
       FROM review_set_repos rsr
       JOIN forge_connections fc ON fc.id = rsr.connection_id
       WHERE rsr.review_set_id = ?`,
    )
    .all(id)
    .map((entry) => ({ kind: entry.kind, host: hostOf(entry.base_url), org: organizationOf(entry.base_url), repo: entry.repo }));
  if (!(await reposAccessible(userId, repos))) throw new HttpError(404, 'Review set not found');
  return { row, owned: false, owner: ownerInfo(row.owner_id) };
}

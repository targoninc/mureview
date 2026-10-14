import type { RepoStatus, ReviewSet } from '../shared/types';
import { repoLabel } from '../shared/types';
import { mapLimit } from './cache';
import { config } from './config';
import { db } from './db';
import type { ForgeClient } from './forges';
import { forgeErrorMessage } from './validate';

/** The public mureview page of a review set. */
export function reviewSetUrl(reviewSetId: number): string {
  return `${config.baseUrl}/review-sets/${reviewSetId}`;
}

export interface RepoPullRow {
  forge_pr_ref: string;
  head_sha: string;
}

export function repoPullRequest(prId: number, connectionId: number, repo: string, position = 0): RepoPullRow | null {
  return (
    db
      .query<RepoPullRow, [number, number, string, number]>(
        'SELECT forge_pr_ref, head_sha FROM pull_request_repos WHERE pr_id = ? AND connection_id = ? AND repo = ? AND position = ?',
      )
      .get(prId, connectionId, repo, position) ?? null
  );
}

/** The forge pull request tracked for a repository of a review set. */
export function reviewSetPullRequest(reviewSetId: number, connectionId: number, repo: string, position = 0): string | null {
  const row = db
    .query<{ forge_pr_ref: string }, [number, number, string, number]>(
      `SELECT rp.forge_pr_ref FROM pull_request_repos rp
       JOIN pull_requests p ON p.id = rp.pr_id
       WHERE p.review_set_id = ? AND p.closed_at IS NULL AND rp.connection_id = ? AND rp.repo = ? AND rp.position = ?
       ORDER BY rp.pr_id DESC LIMIT 1`,
    )
    .get(reviewSetId, connectionId, repo, position);
  return row?.forge_pr_ref ?? null;
}

/**
 * Every open repository gets a real pull request as soon as the review set has
 * one, so comments can be synced to the forge right away instead of waiting
 * for the merge. Existing pull requests are reused.
 */
export async function ensureRepoPullRequests(
  clients: Map<number, ForgeClient>,
  reviewSet: ReviewSet,
  repos: RepoStatus[],
  prId: number,
): Promise<void> {
  const pending = repos.filter(
    (repo) =>
      repo.state === 'open' &&
      repo.branch &&
      repo.targetExists &&
      repo.position >= 0 &&
      !repoPullRequest(prId, repo.connectionId, repo.repo, repo.position),
  );
  await mapLimit(pending, 3, async (repo) => {
    const client = clients.get(repo.connectionId);
    if (!client || client.readOnly) return;
    try {
      // Each layer's pull request targets the layer below it (the review set's
      // target branch for the bottom layer).
      const base = repo.target || reviewSet.targetBranch;
      const pull = await client.ensurePullRequest(
        repo.repo,
        base,
        repo.branch!,
        `Merge ${repo.branch} into ${base}`,
        `Review set: ${reviewSet.name}`,
        reviewSetUrl(reviewSet.id),
      );
      db.run(
        `INSERT INTO pull_request_repos (pr_id, connection_id, repo, position, forge_pr_ref, head_sha) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pr_id, connection_id, repo, position)
         DO UPDATE SET forge_pr_ref = excluded.forge_pr_ref, head_sha = excluded.head_sha`,
        [prId, repo.connectionId, repo.repo, repo.position, pull.ref, repo.headSha ?? ''],
      );
    } catch (error) {
      // Surfaced on the review page; creating pull requests must not fail
      // silently, the forge usually explains what is missing.
      repo.prError = forgeErrorMessage(error);
      console.error(`Could not ensure a pull request for ${repoLabel(repo)}:`, error);
    }
  });

  attachKnownPullRequests(clients, repos, prId);
}

/** Attaches pull request links that are already tracked, without any forge call. */
export function attachKnownPullRequests(clients: Map<number, ForgeClient>, repos: RepoStatus[], prId: number | null): void {
  if (!prId) return;
  for (const repo of repos) {
    if (repo.state !== 'open' || !repo.targetExists || repo.position < 0 || repo.pullRequest) continue;
    const row = repoPullRequest(prId, repo.connectionId, repo.repo, repo.position);
    const client = clients.get(repo.connectionId);
    if (row && client) repo.pullRequest = { ref: row.forge_pr_ref, url: client.pullRequestUrl(repo.repo, row.forge_pr_ref) };
  }
}

export function markCommentSynced(commentId: number, forgeCommentId?: string): void {
  db.run(`UPDATE comments SET synced_at = datetime('now'), forge_comment_id = COALESCE(?, forge_comment_id) WHERE id = ?`, [
    forgeCommentId ?? null,
    commentId,
  ]);
}

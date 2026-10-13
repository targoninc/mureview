import type { RepoStatus, ReviewSet } from '../shared/types';
import { mapLimit } from './cache';
import { db } from './db';
import type { ForgeClient } from './forges';

export interface RepoPullRow {
  forge_pr_number: number;
  head_sha: string;
}

export function repoPullRequest(prId: number, connectionId: number, repo: string): RepoPullRow | null {
  return (
    db
      .query<RepoPullRow, [number, number, string]>(
        'SELECT forge_pr_number, head_sha FROM pull_request_repos WHERE pr_id = ? AND connection_id = ? AND repo = ?',
      )
      .get(prId, connectionId, repo) ?? null
  );
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
    (repo) => repo.state === 'open' && repo.branch && repo.targetExists && !repoPullRequest(prId, repo.connectionId, repo.repo),
  );
  await mapLimit(pending, 3, async (repo) => {
    const client = clients.get(repo.connectionId);
    if (!client) return;
    try {
      const pull = await client.ensurePullRequest(
        repo.repo,
        reviewSet.targetBranch,
        repo.branch!,
        `Merge ${repo.branch} into ${reviewSet.targetBranch}`,
        `Review set: ${reviewSet.name}`,
      );
      db.run(
        `INSERT INTO pull_request_repos (pr_id, connection_id, repo, forge_pr_number, head_sha) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pr_id, connection_id, repo)
         DO UPDATE SET forge_pr_number = excluded.forge_pr_number, head_sha = excluded.head_sha`,
        [prId, repo.connectionId, repo.repo, pull.number, repo.headSha ?? ''],
      );
    } catch (error) {
      console.error(`Could not ensure a pull request for ${repo.host}/${repo.repo}:`, error);
    }
  });

  for (const repo of repos) {
    if (repo.state !== 'open' || !repo.targetExists || repo.pullRequest) continue;
    const row = repoPullRequest(prId, repo.connectionId, repo.repo);
    const client = clients.get(repo.connectionId);
    if (row && client) repo.pullRequest = { number: row.forge_pr_number, url: client.pullRequestUrl(repo.repo, row.forge_pr_number) };
  }
}

export function markCommentSynced(commentId: number): void {
  db.run(`UPDATE comments SET synced_at = datetime('now') WHERE id = ?`, [commentId]);
}

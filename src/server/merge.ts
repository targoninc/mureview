import type { MergeResult } from '../shared/types';
import { connectionsFor } from './auth/identities';
import { requireUser } from './auth/session';
import { mapLimit } from './cache';
import { listUnsyncedComments } from './comments';
import { invalidateForgeCaches } from './forges';
import { HttpError, json } from './http';
import { buildMergePreview } from './mergePreview';
import { buildPrStatus, clientsForActor } from './pr';
import { markCommentSynced, reviewSetUrl } from './pullRequests';
import { buildDetail, loadReadableReviewSet, requireId } from './reviewSets';
import type { Ctx } from './router';
import { forgeErrorMessage } from './validate';

/**
 * Streams the merge preview as newline JSON: `{target}` and the full
 * repository list first, then `{status}` as each repository's branch is
 * inspected, then `{repo}` cards as their conflicts and checks are checked,
 * then `{done: {canMerge}}`.
 */
export async function streamMergePreview(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const access = await loadReadableReviewSet(user, requireId(ctx));
  const connections = connectionsFor(access.ownerId);
  const clients = clientsForActor(user.id, connections);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The client went away.
        }
      };
      try {
        send({ target: access.reviewSet.targetBranch, repos: access.reviewSet.repos });
        const preview = await buildMergePreview(connections, access.reviewSet, {
          progressUserId: user.id,
          viewerId: user.id,
          clients,
          onStatus: (repo) => send({ status: repo }),
          onStart: (total) => send({ checking: total }),
          onRepo: (repo) => send({ repo }),
        });
        send({ done: { canMerge: preview.canMerge } });
      } catch (error) {
        if (error instanceof HttpError) send({ error: error.message });
        else {
          console.error('Could not stream the merge preview:', error);
          send({ error: 'Could not check the repositories for merging.' });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function mergeReviewSet(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const access = await loadReadableReviewSet(user, requireId(ctx));
  const reviewSet = access.reviewSet;
  const connections = connectionsFor(access.ownerId);
  // Merge with the acting user's own credentials: they may be merging a
  // shared review set, and the review set's creator may lack the rights.
  const clients = clientsForActor(user.id, connections);

  const current = await buildPrStatus(connections, reviewSet, true, { commits: false, clients, viewerId: user.id });
  const openRepos = current.repos.filter((repo) => repo.state === 'open' && repo.branch);
  if (!openRepos.length) {
    throw new HttpError(400, 'Nothing to merge: no matched branch has changes against the target branch.');
  }

  const target = reviewSet.targetBranch;
  const unsynced = current.prId ? listUnsyncedComments(current.prId) : [];
  const results = await mapLimit(openRepos, 3, async (repo): Promise<MergeResult> => {
    const label = `${repo.host}/${repo.repo}`;
    const client = clients.get(repo.connectionId);
    if (!client) return { connectionId: repo.connectionId, label, ok: false, message: 'the forge connection was removed' };
    try {
      const headRef = await client.getBranch(repo.repo, repo.branch!, { fresh: true });
      if (!headRef) throw new Error('the matched branch no longer exists');

      const checks = await client.checks(repo.repo, headRef.sha, { pullRequest: repo.pullRequest?.number });
      if (checks.state === 'failure') {
        const failing = checks.runs
          .filter((run) => run.state === 'failure')
          .map((run) => run.name)
          .join(', ');
        return { connectionId: repo.connectionId, label, ok: false, message: `required checks are failing (${failing})` };
      }

      if (!repo.targetExists) {
        await client.createBranch(repo.repo, target, { sha: headRef.sha, branch: repo.branch! });
        return { connectionId: repo.connectionId, label, ok: true, message: `created ${target} from ${repo.branch}` };
      }

      const pullNumber =
        repo.pullRequest?.number ??
        (
          await client.ensurePullRequest(
            repo.repo,
            target,
            repo.branch!,
            `Merge ${repo.branch} into ${target}`,
            `Review set: ${reviewSet.name}`,
            reviewSetUrl(reviewSet.id),
          )
        ).number;

      // Comments are synced as they are written; this catches the ones whose
      // immediate sync failed.
      const comments = unsynced.filter((comment) => comment.connectionId === repo.connectionId && comment.repo === repo.repo);
      let posted = 0;
      let failed = 0;
      for (const comment of comments) {
        try {
          await client.postReviewComment(repo.repo, pullNumber, {
            body: comment.body,
            path: comment.path!,
            line: comment.line!,
            side: comment.side!,
            commitId: repo.headSha ?? headRef.sha,
          });
          markCommentSynced(comment.id);
          posted++;
        } catch {
          failed++;
        }
      }

      const message = await client.mergePullRequest(repo.repo, pullNumber, `Merge ${repo.branch} into ${target}`);
      const commentNote = [
        posted > 0 ? `${posted} late comment${posted === 1 ? '' : 's'} synced` : '',
        failed > 0 ? `${failed} comment${failed === 1 ? '' : 's'} could not be synced` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return { connectionId: repo.connectionId, label, ok: true, message: `${message}${commentNote ? ` · ${commentNote}` : ''}` };
    } catch (error) {
      return { connectionId: repo.connectionId, label, ok: false, message: forgeErrorMessage(error) };
    }
  });

  invalidateForgeCaches();
  const detail = await buildDetail(user, reviewSet.id, true);
  return json({ results, detail });
}

import type { MergeResult } from '../shared/types';
import { connectionsFor } from './auth/identities';
import { requireUser } from './auth/session';
import { mapLimit } from './cache';
import { invalidateForgeCaches } from './forges';
import { HttpError, json } from './http';
import { buildMergePreview } from './mergePreview';
import { buildPrStatus, clientsFor } from './pr';
import { buildDetail, loadOwnedReviewSet, requireId } from './reviewSets';
import type { Ctx } from './router';
import { forgeErrorMessage } from './validate';

export async function getMergePreview(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const reviewSet = loadOwnedReviewSet(user, requireId(ctx));
  return json(await buildMergePreview(connectionsFor(user.id), reviewSet));
}

export async function mergeReviewSet(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const reviewSet = loadOwnedReviewSet(user, requireId(ctx));
  const connections = connectionsFor(user.id);
  const clients = clientsFor(connections);

  const current = await buildPrStatus(connections, reviewSet, true);
  const openRepos = current.repos.filter((repo) => repo.state === 'open' && repo.branch);
  if (!openRepos.length) {
    throw new HttpError(400, 'Nothing to merge: no matched branch has changes against the target branch.');
  }

  const target = reviewSet.targetBranch;
  const results = await mapLimit(openRepos, 3, async (repo): Promise<MergeResult> => {
    const label = `${repo.host}/${repo.repo}`;
    const client = clients.get(repo.connectionId);
    if (!client) return { connectionId: repo.connectionId, label, ok: false, message: 'the forge connection was removed' };
    try {
      const headRef = await client.getBranch(repo.repo, repo.branch!, { fresh: true });
      if (!headRef) throw new Error('the matched branch no longer exists');

      const checks = await client.checks(repo.repo, headRef.sha);
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

      const pull = await client.ensurePullRequest(repo.repo, target, repo.branch!, `mureview: merge ${repo.branch} into ${target}`);

      const comments = current.comments.filter(
        (comment) => comment.connectionId === repo.connectionId && comment.repo === repo.repo && comment.path && comment.line && comment.side,
      );
      let posted = 0;
      let failed = 0;
      for (const comment of comments) {
        try {
          await client.postReviewComment(repo.repo, pull.number, {
            body: comment.body,
            path: comment.path!,
            line: comment.line!,
            side: comment.side!,
            commitId: headRef.sha,
          });
          posted++;
        } catch {
          failed++;
        }
      }

      const message = await client.mergePullRequest(repo.repo, pull.number, `mureview: merge ${repo.branch} into ${target}`);
      const commentNote = [
        posted > 0 ? `${posted} comment${posted === 1 ? '' : 's'} posted` : '',
        failed > 0 ? `${failed} comment${failed === 1 ? '' : 's'} could not be posted` : '',
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

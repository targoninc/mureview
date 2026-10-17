import type { MergeResult, RepoStatus } from '../shared/types';
import { repoLabel } from '../shared/types';
import { connectionsFor } from './auth/identities';
import { requireUser } from './auth/session';
import { mapLimit } from './cache';
import { listUnsyncedComments } from './comments';
import { invalidateForgeCaches } from './forges';
import { HttpError, json, readJson } from './http';
import { buildMergePreview } from './mergePreview';
import { publish } from './live';
import { canManageReviewSet } from './permissions';
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
  if (!(await canManageReviewSet(user.id, access.reviewSet, connections))) {
    throw new HttpError(403, 'You need merge permission on every repository in this review set.');
  }
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
  const body = await readJson<{ deleteBranches?: unknown }>(ctx.req).catch(() => ({ deleteBranches: undefined }));
  const deleteBranches = body.deleteBranches === true;
  const access = await loadReadableReviewSet(user, requireId(ctx));
  const reviewSet = access.reviewSet;
  const connections = connectionsFor(access.ownerId);
  if (!(await canManageReviewSet(user.id, reviewSet, connections))) {
    throw new HttpError(403, 'You need merge permission on every repository in this review set.');
  }
  // Merge with the acting user's own credentials: they may be merging a
  // shared review set, and the review set's creator may lack the rights.
  const clients = clientsForActor(user.id, connections);

  const current = await buildPrStatus(connections, reviewSet, true, { commits: false, clients, viewerId: user.id });
  // Layers that still have changes, plus layers already merged (so a stack's
  // order is known even when its bottom layers landed in an earlier run).
  const candidates = current.repos.filter(
    (repo) => repo.branch && repo.position >= 0 && (repo.state === 'open' || repo.state === 'merged'),
  );
  if (!candidates.some((repo) => repo.state === 'open')) {
    throw new HttpError(400, 'Nothing to merge: no matched branch has changes against the target branch.');
  }

  // One task per repository; the layers of a stack merge bottom-up.
  const groups = new Map<string, RepoStatus[]>();
  for (const repo of candidates) {
    const key = `${repo.connectionId}:${repo.repo}`;
    const group = groups.get(key) ?? [];
    group.push(repo);
    groups.set(key, group);
  }

  const unsynced = current.prId ? listUnsyncedComments(current.prId) : [];
  const results = await mapLimit([...groups.values()], 3, async (layers): Promise<MergeResult> => {
    const first = layers[0];
    const label = repoLabel(first);
    const client = clients.get(first.connectionId);
    if (!client) return { connectionId: first.connectionId, label, ok: false, message: 'the forge connection was removed', mergedPrs: 0 };
    if (client.readOnly) return { connectionId: first.connectionId, label, ok: false, message: 'mureview cannot merge on this forge yet', mergedPrs: 0 };

    const ordered = [...layers].sort((a, b) => a.position - b.position);
    const stacked = ordered.length > 1 || first.position > 0;
    const messages: string[] = [];
    let failed = false;
    let mergedPrs = 0;

    for (const layer of ordered) {
      const layerName = stacked ? `layer ${layer.position + 1} (${layer.branch})` : layer.branch!;
      if (failed) {
        messages.push(`${layerName} was not merged`);
        continue;
      }
      if (layer.state === 'error') {
        messages.push(`${layerName}: ${layer.error ?? 'the branch could not be read'}`);
        failed = true;
        continue;
      }
      if (layer.state === 'merged') {
        mergedPrs += 1;
        if (deleteBranches && client.deleteBranch) {
          try {
            await client.deleteBranch(layer.repo, layer.branch!);
            messages.push(`${layerName} was already merged, source branch deleted`);
          } catch (error) {
            messages.push(`${layerName} was already merged, but the source branch could not be deleted (${forgeErrorMessage(error)})`);
          }
          continue;
        }
        messages.push(`${layerName} was already merged`);
        continue;
      }
      const target = layer.target || reviewSet.targetBranch;
      try {
        const headRef = await client.getBranch(layer.repo, layer.branch!, { fresh: true });
        if (!headRef) throw new Error('the matched branch no longer exists');

        const checks = await client.checks(layer.repo, headRef.sha, { pullRequest: layer.pullRequest?.ref });
        if (checks.state === 'failure') {
          const failing = checks.runs
            .filter((run) => run.state === 'failure')
            .map((run) => run.name)
            .join(', ');
          messages.push(`${layerName}: required checks are failing (${failing})`);
          failed = true;
          continue;
        }

        if (!layer.targetExists) {
          await client.createBranch(layer.repo, target, { sha: headRef.sha, branch: layer.branch! });
          messages.push(`${layerName}: created ${target} from ${layer.branch}`);
          continue;
        }

        const pullRef =
          (layer.pullRequest?.state === 'closed' ? undefined : layer.pullRequest?.ref) ??
          (
            await client.ensurePullRequest(
              layer.repo,
              target,
              layer.branch!,
              `Merge ${layer.branch} into ${target}`,
              `Review set: ${reviewSet.name}`,
              reviewSetUrl(reviewSet.id),
            )
          ).ref;

        // Once the layers below are in, an upper layer's pull request points
        // at the review set's target so its merge lands there too.
        if (stacked && layer.position > 0 && target !== reviewSet.targetBranch && client.retargetPullRequest) {
          await client.retargetPullRequest(layer.repo, pullRef, reviewSet.targetBranch);
        }

        // Comments are synced as they are written; this catches the ones whose
        // immediate sync failed.
        const comments = unsynced.filter(
          (comment) =>
            comment.connectionId === layer.connectionId && comment.repo === layer.repo && comment.position === layer.position,
        );
        let posted = 0;
        let commentFailed = 0;
        for (const comment of comments) {
          try {
            await client.postReviewComment(layer.repo, pullRef, {
              body: comment.body,
              path: comment.path!,
              line: comment.line!,
              side: comment.side!,
              commitId: layer.headSha ?? headRef.sha,
            });
            markCommentSynced(comment.id);
            posted++;
          } catch {
            commentFailed++;
          }
        }

        const message = await client.mergePullRequest(layer.repo, pullRef, `Merge ${layer.branch} into ${target}`);
        mergedPrs += 1;
        let branchNote = '';
        if (deleteBranches) {
          if (!client.deleteBranch) {
            branchNote = 'the source branch was kept (this forge cannot delete branches)';
          } else {
            try {
              await client.deleteBranch(layer.repo, layer.branch!);
              branchNote = 'source branch deleted';
            } catch (error) {
              branchNote = `the source branch could not be deleted (${forgeErrorMessage(error)})`;
            }
          }
        }
        const commentNote = [
          posted > 0 ? `${posted} late comment${posted === 1 ? '' : 's'} synced` : '',
          commentFailed > 0 ? `${commentFailed} comment${commentFailed === 1 ? '' : 's'} could not be synced` : '',
          branchNote,
        ]
          .filter(Boolean)
          .join(' · ');
        messages.push(`${layerName}: ${message}${commentNote ? ` · ${commentNote}` : ''}`);
      } catch (error) {
        messages.push(`${layerName}: ${forgeErrorMessage(error)}`);
        failed = true;
      }
    }
    return { connectionId: first.connectionId, label, ok: !failed, message: messages.join(' · '), mergedPrs };
  });

  invalidateForgeCaches();
  const detail = await buildDetail(user, reviewSet.id, true);
  publish(reviewSet.id, { type: 'prs', reason: 'merged' });
  return json({ results, detail });
}

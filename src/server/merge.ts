import type { MergeResult } from '../shared/types';
import { requireUser, userToken } from './auth';
import { mapLimit } from './cache';
import { createRef, getBranchCached, invalidateBranchCaches, mergeBranch } from './github';
import { HttpError, json } from './http';
import { buildPrStatus } from './pr';
import { buildDetail, loadOwnedReviewSet, requireId } from './reviewSets';
import type { Ctx } from './router';
import { githubErrorMessage } from './validate';

export async function mergeReviewSet(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const reviewSet = loadOwnedReviewSet(user, requireId(ctx));
  const token = userToken(user);

  const current = await buildPrStatus(token, reviewSet, true);
  const openRepos = current.repos.filter((repo) => repo.state === 'open' && repo.branch);
  if (!openRepos.length) {
    throw new HttpError(400, 'Nothing to merge: no matched branch has changes against the target branch.');
  }

  const target = reviewSet.targetBranch;
  const results = await mapLimit(openRepos, 3, async (repo): Promise<MergeResult> => {
    try {
      if (repo.targetExists) {
        const message = await mergeBranch(token, repo.repo, target, repo.branch!, `mureview: merge ${repo.branch} into ${target}`);
        return { repo: repo.repo, ok: true, message };
      }
      const branchRef = await getBranchCached(token, repo.repo, repo.branch!, true);
      if (!branchRef) throw new Error('the matched branch no longer exists');
      await createRef(token, repo.repo, target, branchRef.commit.sha);
      return { repo: repo.repo, ok: true, message: `created ${target} from ${repo.branch}` };
    } catch (error) {
      return { repo: repo.repo, ok: false, message: githubErrorMessage(error) };
    }
  });

  invalidateBranchCaches();
  const detail = await buildDetail(user, reviewSet.id, true);
  return json({ results, detail });
}

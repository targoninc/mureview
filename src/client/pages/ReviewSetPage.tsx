import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Flash } from '@primer/react';
import type { RepoCommits, ReviewSetDiscussion } from '../../shared/types';
import { PrView } from '../components/pr/PrView';
import { ReviewSetLoading } from '../components/pr/ReviewSetLoading';
import { api } from '../lib/api';
import { useDetail } from '../lib/useDetail';

export function ReviewSetPage() {
  const { id } = useParams();
  const { detail, error, reload, loading } = useDetail(id);
  const [discussion, setDiscussion] = useState<ReviewSetDiscussion | null>(null);
  const [commits, setCommits] = useState<RepoCommits[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const prId = detail?.pr.prId ?? null;

  // The discussion (pull requests, merged comments, reviewed files) and the
  // commit lists load in parallel after the fast core detail response.
  useEffect(() => {
    if (!prId) {
      setDiscussion(null);
      return;
    }
    let cancelled = false;
    const sync = reloadKey === 0 ? '1' : 'force';
    api<ReviewSetDiscussion>(`/review-sets/${id}/discussion?sync=${sync}`)
      .then((result) => {
        if (!cancelled) setDiscussion(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, prId, reloadKey]);

  useEffect(() => {
    if (!id || !detail) return;
    let cancelled = false;
    api<{ repos: RepoCommits[] }>(`/review-sets/${id}/commits`)
      .then((result) => {
        if (!cancelled) setCommits(result.repos);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, detail, reloadKey]);

  const merged = useMemo(() => {
    if (!detail) return null;
    const keyOf = (entry: { connectionId: number; repo: string; position: number }) =>
      `${entry.connectionId}:${entry.repo}:${entry.position}`;
    const pullsByRepo = new Map((discussion?.pullRequests ?? []).map((pull) => [keyOf(pull), pull]));
    const commitsByRepo = new Map((commits ?? []).map((bundle) => [keyOf(bundle), bundle.commits]));
    return {
      reviewSet: detail.reviewSet,
      owned: detail.owned,
      owner: detail.owner,
      pr: {
        ...detail.pr,
        comments: discussion?.comments ?? detail.pr.comments,
        reviewed: discussion?.reviewed ?? detail.pr.reviewed,
        repos: detail.pr.repos.map((repo) => {
          const key = keyOf(repo);
          const pull = pullsByRepo.get(key);
          return {
            ...repo,
            pullRequest: repo.pullRequest ?? (pull ? { ref: pull.ref, url: pull.url } : undefined),
            commits: commitsByRepo.get(key) ?? repo.commits,
          };
        }),
      },
    };
  }, [detail, discussion, commits]);

  const reloadAll = useCallback(
    (fresh?: boolean) => {
      setReloadKey((key) => key + 1);
      reload(fresh);
    },
    [reload],
  );

  if (error) {
    return (
      <div className="page-scroll">
        <div className="page-inner">
          <Flash variant="danger">{error}</Flash>
        </div>
      </div>
    );
  }

  if (!merged) {
    return <ReviewSetLoading id={id} />;
  }

  return <PrView detail={merged} onReload={reloadAll} progress={loading} />;
}

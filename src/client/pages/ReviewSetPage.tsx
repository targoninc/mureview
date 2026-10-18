import { useCallback, useEffect, useMemo, useState } from 'react';
import { repoItemKey } from '../lib/format';
import { useParams } from 'react-router-dom';
import { Flash } from '@primer/react';
import type { RepoCommits, ReviewMark, ReviewSetDiscussion } from '../../shared/types';
import { PrView } from '../components/pr/PrView';
import { ReviewSetLoading } from '../components/pr/ReviewSetLoading';
import { api } from '../lib/api';
import { useAppContext } from '../lib/appContext';
import { marksKey, readCachedMarks } from '../lib/markCache';
import { useDetail } from '../lib/useDetail';

export function ReviewSetPage() {
  const { id } = useParams();
  const { user } = useAppContext();
  const { detail, error, reload, loading } = useDetail(id);
  const [discussion, setDiscussion] = useState<ReviewSetDiscussion | null>(null);
  const [commits, setCommits] = useState<RepoCommits[] | null>(null);
  const [cachedMarks, setCachedMarks] = useState<ReviewMark[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [syncComments, setSyncComments] = useState(false);
  const prId = detail?.pr.prId ?? null;

  // The last seen checkmarks, so the tree is right from the first paint.
  useEffect(() => {
    if (!user || !id) return;
    let cancelled = false;
    void readCachedMarks(marksKey(user.id, id)).then((marks) => {
      if (!cancelled && marks) setCachedMarks(marks);
    });
    return () => {
      cancelled = true;
    };
  }, [user, id]);

  // The discussion (pull requests, merged comments) and the commit lists load
  // in parallel after the fast core detail response. Importing the forge
  // comments is expensive, so it is left to the server's throttle, and forced
  // only when the user asked for a refresh.
  useEffect(() => {
    if (!prId) {
      setDiscussion(null);
      return;
    }
    let cancelled = false;
    api<ReviewSetDiscussion>(`/review-sets/${id}/discussion?sync=${syncComments ? 'force' : '1'}`)
      .then((result) => {
        if (!cancelled) setDiscussion(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, prId, reloadKey, syncComments]);

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
    const keyOf = repoItemKey;
    const pullsByRepo = new Map((discussion?.pullRequests ?? []).map((pull) => [keyOf(pull), pull]));
    const prErrors = new Map((discussion?.prErrors ?? []).map((entry) => [keyOf(entry), entry.message]));
    const commitsByRepo = new Map((commits ?? []).map((bundle) => [keyOf(bundle), bundle.commits]));
    return {
      reviewSet: detail.reviewSet,
      owned: detail.owned,
      owner: detail.owner,
      canManage: detail.canManage,
      pr: {
        ...detail.pr,
        comments: discussion?.comments ?? detail.pr.comments,
        // The detail carries the viewed marks. While it loads, the cached
        // marks from the last visit stand in, or the previous discussion when
        // a reload is in flight.
        reviewed:
          detail.pr.state === 'loading'
            ? (discussion?.reviewed ?? cachedMarks ?? detail.pr.reviewed)
            : detail.pr.reviewed,
        repos: detail.pr.repos.map((repo) => {
          const key = keyOf(repo);
          const pull = pullsByRepo.get(key);
          return {
            ...repo,
            pullRequest: repo.pullRequest ?? (pull ? { ref: pull.ref, url: pull.url } : undefined),
            prError: prErrors.get(key) ?? repo.prError,
            commits: commitsByRepo.get(key) ?? repo.commits,
          };
        }),
      },
    };
  }, [detail, discussion, commits, cachedMarks]);

  const reloadAll = useCallback(
    (fresh?: boolean) => {
      setSyncComments(Boolean(fresh));
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

import { useCallback, useState } from 'react';
import { Flash, useConfirm } from '@primer/react';
import type { MergeResult, PrStatus, ReviewSet, ReviewSetDetail } from '../../../shared/types';
import { post } from '../../lib/api';

export function MergeResultsFlash({ results }: { results: MergeResult[] }) {
  const failed = results.filter((result) => !result.ok);
  const variant = failed.length === 0 ? 'success' : failed.length === results.length ? 'danger' : 'warning';
  return (
    <Flash variant={variant}>
      <strong>{failed.length === 0 ? 'Merge complete' : failed.length === results.length ? 'Merge failed' : 'Merge partially complete'}</strong>
      <ul className="error-list">
        {results.map((result) => (
          <li key={`${result.repo}:${result.message}`}>
            {result.repo ? <span className="mono">{result.repo}: </span> : null}
            {result.message}
          </li>
        ))}
      </ul>
    </Flash>
  );
}

export function useMerge(pr: PrStatus, reviewSet: ReviewSet, onDetail: (detail: ReviewSetDetail) => void) {
  const [merging, setMerging] = useState(false);
  const [results, setResults] = useState<MergeResult[] | null>(null);
  const confirm = useConfirm();

  const merge = useCallback(async () => {
    const openRepos = pr.repos.filter((repo) => repo.state === 'open' && repo.branch);
    if (!openRepos.length) return;
    const approved = await confirm({
      title: `Merge into ${reviewSet.targetBranch}?`,
      content: (
        <>
          <p>mureview will merge on GitHub:</p>
          <ul className="error-list">
            {openRepos.map((repo) => (
              <li key={repo.repo}>
                <span className="mono">
                  {repo.repo}: {repo.branch} → {reviewSet.targetBranch}
                </span>
              </li>
            ))}
          </ul>
          <p>When every matched branch is merged, this review closes and its comments are deleted.</p>
        </>
      ),
      confirmButtonContent: 'Merge',
      cancelButtonContent: 'Cancel',
    });
    if (!approved) return;

    setMerging(true);
    setResults(null);
    try {
      const result = await post<{ results: MergeResult[]; detail: ReviewSetDetail }>(`/review-sets/${reviewSet.id}/merge`, {});
      setResults(result.results);
      onDetail(result.detail);
    } catch (error) {
      setResults([{ repo: '', ok: false, message: (error as Error).message }]);
    } finally {
      setMerging(false);
    }
  }, [pr, reviewSet, confirm, onDetail]);

  return { merge, merging, results };
}

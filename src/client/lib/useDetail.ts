import { useCallback, useEffect, useRef, useState } from 'react';
import type { PrStatus, RepoStatus, ReviewSet, ReviewSetDetail } from '../../shared/types';
import { ApiError, basePath } from './api';

interface LoadCount {
  loaded: number;
  total: number;
}

type StreamEvent =
  | { reviewSet: ReviewSet; owned: boolean; owner: ReviewSetDetail['owner'] }
  | { repo: RepoStatus }
  | { done: PrStatus }
  | { error: string };

const loadingPr = (): PrStatus => ({
  state: 'loading',
  errors: [],
  repos: [],
  prId: null,
  comments: [],
  reviewed: [],
  stats: { repos: 0, files: 0, additions: 0, deletions: 0 },
});

/**
 * Loads a review set while streaming the repository statuses: the page can
 * render as soon as the first repository is ready and fill in the rest, with
 * `loading` reporting how many repositories have arrived. The refreshing flag
 * reports whether an old detail is being replaced.
 */
export function useDetail(id: string | undefined) {
  const [detail, setDetail] = useState<ReviewSetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<LoadCount | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const reload = useCallback(
    (fresh = false) => {
      if (!id) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      let reviewSet: ReviewSet | null = null;
      let owned = true;
      let owner: ReviewSetDetail['owner'] = null;
      const repoEvents: RepoStatus[] = [];

      const commit = (pr: PrStatus) => {
        if (!reviewSet) return;
        setDetail({ reviewSet, owned, owner, pr });
      };

      const handle = (event: StreamEvent) => {
        if ('reviewSet' in event) {
          reviewSet = event.reviewSet;
          owned = event.owned;
          owner = event.owner;
          setLoading({ loaded: 0, total: event.reviewSet.repos.length });
          // A review set without repositories never produces a repo event.
          if (event.reviewSet.repos.length === 0) commit(loadingPr());
        } else if ('repo' in event) {
          repoEvents.push(event.repo);
          setLoading({ loaded: repoEvents.length, total: reviewSet?.repos.length ?? repoEvents.length });
          commit({ ...loadingPr(), repos: [...repoEvents] });
        } else if ('done' in event) {
          commit(event.done);
          setLoading(null);
        } else if ('error' in event) {
          setError(event.error);
          setLoading(null);
        }
      };

      setError(null);
      setLoading(null);

      void (async () => {
        try {
          const response = await fetch(`${basePath}/api/review-sets/${id}/detail${fresh ? '?fresh=1' : ''}`, {
            signal: controller.signal,
            headers: { Accept: 'application/x-ndjson' },
          });
          if (!response.ok || !response.body) {
            let message = response.statusText;
            try {
              message = ((await response.json()) as { error?: string }).error ?? message;
            } catch {
              // keep the status text
            }
            throw new ApiError(response.status, message);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.trim()) continue;
              handle(JSON.parse(line) as StreamEvent);
            }
          }
        } catch (err) {
          if ((err as Error).name === 'AbortError') return;
          setError((err as Error).message);
          setLoading(null);
        }
      })();
    },
    [id],
  );

  useEffect(() => {
    setDetail(null);
    reload();
  }, [reload]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { detail, error, loading, reload };
}

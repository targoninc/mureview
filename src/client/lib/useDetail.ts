import { useCallback, useEffect, useState } from 'react';
import type { ReviewSetDetail } from '../../shared/types';
import { api } from './api';

export function useDetail(id: string | undefined) {
  const [detail, setDetail] = useState<ReviewSetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    (fresh = false) => {
      if (!id) return;
      api<{ detail: ReviewSetDetail }>(`/review-sets/${id}${fresh ? '?fresh=1' : ''}`)
        .then((result) => {
          setDetail(result.detail);
          setError(null);
        })
        .catch((err: Error) => setError(err.message));
    },
    [id],
  );

  useEffect(() => {
    setDetail(null);
    reload();
  }, [reload]);

  return { detail, error, reload, setDetail };
}

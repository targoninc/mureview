import { useCallback, useEffect, useState } from 'react';
import type { ReviewSetDetail } from '../../shared/types';
import { api } from './api';

export function useDetail(id: string | undefined) {
  const [detail, setDetail] = useState<ReviewSetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!id) return;
    api<{ detail: ReviewSetDetail }>(`/review-sets/${id}`)
      .then((result) => {
        setDetail(result.detail);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [id]);

  useEffect(() => {
    setDetail(null);
    reload();
  }, [reload]);

  return { detail, error, reload, setDetail };
}

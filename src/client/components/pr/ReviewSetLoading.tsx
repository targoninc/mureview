import { useEffect, useState } from 'react';
import { Spinner } from '@primer/react';
import type { LoadPhase, LoadProgress } from '../../../shared/types';
import { api } from '../../lib/api';

const phaseText: Record<LoadPhase, string> = {
  pending: 'waiting',
  checking: 'checking branches',
  diffing: 'building the diff',
  done: 'done',
  error: 'failed',
};

function Progress({ progress }: { progress: LoadProgress }) {
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
        aria-label="Repositories loaded"
      >
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="load-meta">
        {progress.finished
          ? 'Rendering the diff…'
          : `Checked ${progress.done} of ${progress.total} ${progress.total === 1 ? 'repository' : 'repositories'}`}
      </span>
      <ul className="load-repos">
        {progress.repos.map((repo) => (
          <li key={repo.label}>
            <span className={`load-phase load-phase-${repo.phase}`}>{phaseText[repo.phase]}</span>
            <span className="mono load-repo-label">{repo.label}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Follows the server's review set load so the wait has a face. */
export function ReviewSetLoading({ id, title = 'Loading review set…' }: { id: string | undefined; title?: string }) {
  const [progress, setProgress] = useState<LoadProgress | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const poll = () =>
      api<{ progress: LoadProgress | null }>(`/review-sets/${id}/progress`)
        .then((result) => {
          if (!cancelled) setProgress(result.progress);
        })
        .catch(() => undefined);
    poll();
    const timer = setInterval(poll, 400);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);

  return (
    <div className="centered">
      <div className="load-card">
        <Spinner size="medium" aria-label="Loading review set" />
        <div className="stack load-card-body">
          <strong>{title}</strong>
          {progress ? <Progress progress={progress} /> : <span className="load-meta">Talking to the forges…</span>}
        </div>
      </div>
    </div>
  );
}

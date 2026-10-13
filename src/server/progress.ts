import type { LoadPhase, LoadProgress } from '../shared/types';

interface ProgressRepo {
  key: string;
  label: string;
}

interface Run {
  userId: number;
  startedAt: number;
  finishedAt: number | null;
  order: string[];
  repos: Map<string, { label: string; phase: LoadPhase }>;
}

const runs = new Map<number, Run>();
const keepMs = 30_000;

/** Registers a review set load so the client can follow it. */
export function beginRun(userId: number, reviewSetId: number, repos: ProgressRepo[]): void {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (now - run.startedAt > 5 * 60_000) runs.delete(id);
  }
  runs.set(reviewSetId, {
    userId,
    startedAt: now,
    finishedAt: null,
    order: repos.map((repo) => repo.key),
    repos: new Map(repos.map((repo) => [repo.key, { label: repo.label, phase: 'pending' as LoadPhase }])),
  });
}

export function setPhase(reviewSetId: number, key: string, phase: LoadPhase): void {
  const entry = runs.get(reviewSetId)?.repos.get(key);
  if (entry) entry.phase = phase;
}

export function finishRun(reviewSetId: number): void {
  const run = runs.get(reviewSetId);
  if (run) run.finishedAt = Date.now();
}

export function readRun(userId: number, reviewSetId: number): LoadProgress | null {
  const run = runs.get(reviewSetId);
  if (!run || run.userId !== userId) return null;
  if (run.finishedAt && Date.now() - run.finishedAt > keepMs) {
    runs.delete(reviewSetId);
    return null;
  }
  const repos = run.order.map((key) => {
    const entry = run.repos.get(key)!;
    return { label: entry.label, phase: entry.phase };
  });
  return {
    repos,
    done: repos.filter((repo) => repo.phase === 'done' || repo.phase === 'error').length,
    total: repos.length,
    finished: run.finishedAt !== null,
  };
}

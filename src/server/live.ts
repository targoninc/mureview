import type { ServerWebSocket } from 'bun';
import type { UserRow } from './db';
import { db } from './db';
import { loadReadableReviewSet } from './reviewSets';

export interface LiveData {
  user: UserRow;
  /** Review sets this socket watches, with when access was last verified. */
  reviewSets: Map<number, number>;
}

type LiveSocket = ServerWebSocket<LiveData>;

const sockets = new Set<LiveSocket>();

export function liveOpen(ws: LiveSocket): void {
  sockets.add(ws);
}

export function liveClose(ws: LiveSocket): void {
  sockets.delete(ws);
}

export function liveMessage(ws: LiveSocket, raw: string | Buffer): void {
  let message: { type?: unknown; reviewSetId?: unknown };
  try {
    message = JSON.parse(String(raw)) as { type?: unknown; reviewSetId?: unknown };
  } catch {
    return;
  }
  if (message.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }
  const id = Number(message.reviewSetId);
  if (!Number.isInteger(id) || id <= 0) return;
  if (message.type === 'unsubscribe') {
    ws.data.reviewSets.delete(id);
    return;
  }
  if (message.type !== 'subscribe') return;
  void loadReadableReviewSet(ws.data.user, id)
    .then(() => {
      ws.data.reviewSets.set(id, Date.now());
    })
    .catch(() => {
      ws.data.reviewSets.delete(id);
    });
}

const accessTtlMs = 60_000;

/** Access is verified at subscribe time and re-checked while events flow. */
async function stillAllowed(ws: LiveSocket, reviewSetId: number): Promise<boolean> {
  const verified = ws.data.reviewSets.get(reviewSetId);
  if (verified === undefined) return false;
  if (Date.now() - verified < accessTtlMs) return true;
  try {
    await loadReadableReviewSet(ws.data.user, reviewSetId);
    ws.data.reviewSets.set(reviewSetId, Date.now());
    return true;
  } catch {
    ws.data.reviewSets.delete(reviewSetId);
    return false;
  }
}

/** Sends an event to everyone watching a review set and still allowed to. */
export async function publish(reviewSetId: number, event: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify({ ...event, reviewSetId });
  await Promise.all(
    [...sockets].map(async (socket) => {
      if (!socket.data.reviewSets.has(reviewSetId)) return;
      if (!(await stillAllowed(socket, reviewSetId))) return;
      try {
        socket.send(payload);
      } catch {
        sockets.delete(socket);
      }
    }),
  );
}

/** Sends an event to everyone watching the review set a pull request belongs to. */
export async function publishForPr(prId: number, event: Record<string, unknown>): Promise<void> {
  const row = db.query<{ review_set_id: number }, [number]>('SELECT review_set_id FROM pull_requests WHERE id = ?').get(prId);
  if (row) await publish(row.review_set_id, { ...event, prId });
}

/** Sends an event to everyone watching any of the given review sets. */
export async function publishToSets(reviewSetIds: number[], event: Record<string, unknown>): Promise<void> {
  await Promise.all(reviewSetIds.map((id) => publish(id, event)));
}

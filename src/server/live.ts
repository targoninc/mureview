import type { ServerWebSocket } from 'bun';
import type { UserRow } from './db';
import { db } from './db';
import { loadReadableReviewSet } from './reviewSets';

export interface LiveData {
  user: UserRow;
  reviewSets: Set<number>;
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
      ws.data.reviewSets.add(id);
    })
    .catch(() => {
      ws.data.reviewSets.delete(id);
    });
}

/** Sends an event to everyone watching a review set. */
export function publish(reviewSetId: number, event: Record<string, unknown>): void {
  const payload = JSON.stringify({ ...event, reviewSetId });
  for (const socket of sockets) {
    if (!socket.data.reviewSets.has(reviewSetId)) continue;
    try {
      socket.send(payload);
    } catch {
      sockets.delete(socket);
    }
  }
}

/** Sends an event to everyone watching the review set a pull request belongs to. */
export function publishForPr(prId: number, event: Record<string, unknown>): void {
  const row = db.query<{ review_set_id: number }, [number]>('SELECT review_set_id FROM pull_requests WHERE id = ?').get(prId);
  if (row) publish(row.review_set_id, { ...event, prId });
}

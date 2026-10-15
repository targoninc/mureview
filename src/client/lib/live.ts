import { useEffect, useRef } from 'react';
import type { Comment, ReviewVote } from '../../shared/types';
import { basePath } from './api';

export type LiveEvent =
  | {
      type: 'reviewed';
      reviewSetId: number;
      prId: number;
      userId: number;
      userName?: string;
      userAvatar?: string;
      reviewed: boolean;
      itemIds: string[];
    }
  | { type: 'comment'; reviewSetId: number; prId: number; action: 'created'; comment: Comment }
  | { type: 'comment'; reviewSetId: number; prId: number; action: 'deleted' | 'resolved'; commentId: number; resolved?: boolean }
  | { type: 'comments'; reviewSetId: number; prId: number }
  | {
      type: 'vote';
      reviewSetId: number;
      prId: number;
      userId: number;
      connectionId: number;
      repo: string;
      position: number;
      vote: ReviewVote;
    }
  | { type: 'prs'; reviewSetId: number; prId?: number; reason?: string }
  | { type: 'pong'; reviewSetId?: number };

/**
 * Keeps a review set in sync across tabs and devices: the server pushes
 * changes (viewed marks, comments, review decisions, pull request state) to
 * everyone watching the set, and the socket reconnects with backoff.
 */
export function useLiveReviewSet(reviewSetId: number | null | undefined, onEvent: (event: LiveEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!reviewSetId) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let ping: number | undefined;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}${basePath}/api/live`);
      socket.onopen = () => {
        retry = 0;
        socket?.send(JSON.stringify({ type: 'subscribe', reviewSetId }));
        ping = window.setInterval(() => socket?.send(JSON.stringify({ type: 'ping' })), 25_000);
      };
      socket.onmessage = (message) => {
        let event: LiveEvent;
        try {
          event = JSON.parse(String(message.data)) as LiveEvent;
        } catch {
          return;
        }
        if (event.type !== 'pong') handler.current(event);
      };
      socket.onclose = () => {
        if (ping !== undefined) window.clearInterval(ping);
        if (closed) return;
        retry = Math.min(retry + 1, 5);
        window.setTimeout(connect, 1000 * 2 ** retry);
      };
    };

    connect();
    return () => {
      closed = true;
      if (ping !== undefined) window.clearInterval(ping);
      socket?.close();
    };
  }, [reviewSetId]);
}

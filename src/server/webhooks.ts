import { createHmac, timingSafeEqual } from 'node:crypto';
import { syncForgeComments, type SyncTarget } from './commentSync';
import { config } from './config';
import { db, type ForgeConnectionRow } from './db';
import { clientFor, invalidateForgeCaches } from './forges';
import { HttpError, json } from './http';
import { publishToSets } from './live';
import type { Ctx } from './router';

/** The events mureview reacts to; everything else is acknowledged and ignored. */
const commentEvents = new Set(['issue_comment', 'ms.vss-code.git.pull-request-comment-event', 'git.pull-request-comment-event']);
const stateEvents = new Set([
  'pull_request',
  'pull_request_review',
  'push',
  'git.pull-request-updated',
  'git.pull-request-merged',
  'git.push',
]);

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function githubSignature(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function forgejoSignature(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Receives forge webhooks so comments, reviews and pull request changes made
 * on the forge reach open mureview sessions without waiting for a poll. The
 * payloads are verified with the connection's webhook secret, and only the
 * events mureview cares about are turned into live updates for the review
 * sets that track the repository.
 */
export async function forgeWebhook(ctx: Ctx): Promise<Response> {
  const connectionId = Number(ctx.params.connectionId);
  const connection = Number.isInteger(connectionId)
    ? db.query<ForgeConnectionRow, [number]>('SELECT * FROM forge_connections WHERE id = ?').get(connectionId)
    : null;
  if (!connection) throw new HttpError(404, 'Unknown connection');

  const body = await ctx.req.text();
  const secret = connection.webhook_secret ?? '';
  const headers = ctx.req.headers;
  const signature = headers.get('x-hub-signature-256');
  const forgejo = headers.get('x-gitea-signature') ?? headers.get('x-forgejo-signature');
  let verified = false;
  if (secret) {
    if (signature) verified = safeEqual(signature, githubSignature(body, secret));
    else if (forgejo) verified = safeEqual(forgejo, forgejoSignature(body, secret));
    else {
      // Azure DevOps service hooks authenticate with basic auth instead.
      const authorization = headers.get('authorization') ?? '';
      if (authorization.startsWith('Basic ')) {
        const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
        verified = safeEqual(decoded.split(':').slice(1).join(':'), secret);
      }
    }
  }
  if (!verified) throw new HttpError(401, 'Invalid webhook signature');

  const event = headers.get('x-github-event') ?? headers.get('x-gitea-event') ?? headers.get('x-forgejo-event') ?? '';
  let payload: {
    eventType?: string;
    repository?: { full_name?: string };
    resource?: { repository?: { name?: string; project?: { name?: string } } };
  } = {};
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    throw new HttpError(400, 'Webhook body must be JSON');
  }
  const kind = event || payload.eventType || '';
  if (!commentEvents.has(kind) && !stateEvents.has(kind)) return json({ ok: true, ignored: kind });

  const repo = payload.repository?.full_name
    ? payload.repository.full_name
    : payload.resource?.repository?.name
      ? [payload.resource.repository.project?.name, payload.resource.repository.name].filter(Boolean).join('/')
      : null;

  if (!repo) return json({ ok: true, ignored: 'no repository' });
  const rows = db
    .query<{ review_set_id: number }, [number, string, string]>(
      `SELECT DISTINCT review_set_id FROM review_set_repos WHERE connection_id = ? AND (repo = ? OR repo LIKE '%/' || ?)`,
    )
    .all(connectionId, repo, repo);
  if (rows.length === 0) return json({ ok: true, ignored: 'no review set' });

  invalidateForgeCaches();
  const reviewSetIds = rows.map((row) => row.review_set_id);
  if (commentEvents.has(kind)) {
    // Import what the forge just received before telling the clients to refetch.
    const client = clientFor(connection);
    if (client) {
      for (const reviewSetId of reviewSetIds) {
        const pr = db
          .query<{ id: number }, [number]>('SELECT id FROM pull_requests WHERE review_set_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1')
          .get(reviewSetId);
        if (!pr) continue;
        const targets = db
          .query<SyncTarget, [number]>(
            `SELECT rp.connection_id AS connectionId, rp.repo, rp.position, rp.forge_pr_ref AS pullRequestRef
             FROM pull_request_repos rp JOIN pull_requests p ON p.id = rp.pr_id
             WHERE p.review_set_id = ? AND p.closed_at IS NULL`,
          )
          .all(reviewSetId);
        try {
          await syncForgeComments(pr.id, new Map([[connection.id, client]]), targets, true);
        } catch (error) {
          console.error('Could not import the forge comments after a webhook:', error);
        }
      }
    }
  }
  await publishToSets(reviewSetIds, commentEvents.has(kind) ? { type: 'comments', reason: 'forge' } : { type: 'prs', reason: 'forge' });
  return json({ ok: true });
}

/** Registers webhooks for a review set's repositories where the token may. */
const attempted = new Set<string>();

export async function ensureWebhooksForReviewSet(reviewSetId: number): Promise<void> {
  if (!config.baseUrl) return;
  const repos = db
    .query<{ connection_id: number; repo: string }, [number]>(
      'SELECT DISTINCT connection_id, repo FROM review_set_repos WHERE review_set_id = ?',
    )
    .all(reviewSetId);
  for (const entry of repos) {
    const key = `${entry.connection_id}:${entry.repo}`;
    if (attempted.has(key)) continue;
    attempted.add(key);
    const connection = db.query<ForgeConnectionRow, [number]>('SELECT * FROM forge_connections WHERE id = ?').get(entry.connection_id);
    if (!connection) continue;
    const client = clientFor(connection);
    if (!client?.registerWebhook) continue;
    let secret = connection.webhook_secret;
    if (!secret) {
      secret = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
      db.run('UPDATE forge_connections SET webhook_secret = ? WHERE id = ?', [secret, connection.id]);
    }
    const url = `${config.baseUrl}/api/webhooks/forge/${connection.id}`;
    await client.registerWebhook(entry.repo, url, secret);
  }
}

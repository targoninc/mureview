import { createHmac, timingSafeEqual } from 'node:crypto';
import { syncForgeComments, type SyncTarget } from './commentSync';
import { config } from './config';
import { resetMarksForPush } from './reviewed';
import { forgetInstallation, forgetRepoInstallations, installationToken, refreshGithubInstallations, verifyAppSignature } from './githubApp';
import { GithubClient } from './forges/github';
import { db, type ForgeConnectionRow } from './db';
import { type ForgeClient, clientFor, invalidateForgeCaches } from './forges';
import { HttpError, json, readText } from './http';
import { publishToSets } from './live';
import type { Ctx } from './router';

async function handleRepositoryEvent(input: {
  kind: string;
  repo: string;
  reviewSetIds: number[];
  pushes: Array<{ before: string; after: string }>;
  markClient: ForgeClient | null;
  commentClient: ForgeClient | null;
  commentConnectionId?: number;
  reason: string;
}): Promise<void> {
  invalidateForgeCaches();
  if (input.pushes.length > 0 && input.markClient) {
    try {
      for (const push of input.pushes) {
        await resetMarksForPush(input.markClient, input.repo, push.before, push.after, {
          kind: input.markClient.kind,
          connectionId: input.commentConnectionId,
        });
      }
    } catch (error) {
      console.error(`Could not reset the viewed marks after a push (${input.reason}):`, error);
    }
  }
  if (commentEvents.has(input.kind) && input.commentClient) {
    for (const reviewSetId of input.reviewSetIds) {
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
        .all(reviewSetId)
        .filter((target) => input.commentConnectionId === undefined || target.connectionId === input.commentConnectionId);
      try {
        const clients = new Map(targets.map((target) => [target.connectionId, input.commentClient!]));
        await syncForgeComments(pr.id, clients, targets, true);
      } catch (error) {
        console.error(`Could not import comments after a webhook (${input.reason}):`, error);
      }
    }
  }
  await publishToSets(input.reviewSetIds, {
    type: commentEvents.has(input.kind) ? 'comments' : 'prs',
    reason: input.reason,
  });
}

/** The events mureview reacts to; everything else is acknowledged and ignored. */
const commentEvents = new Set(['issue_comment', 'ms.vss-code.git.pull-request-comment-event', 'git.pull-request-comment-event']);
const stateEvents = new Set([
  'pull_request',
  'pull_request_review',
  'push',
  // Branch deletions change what the review set can still compare.
  'delete',
  'git.pull-request-updated',
  'git.pull-request-merged',
  'git.push',
]);

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

interface WebhookPayload {
  eventType?: string;
  /** GitHub and Gitea name the pushed commit range directly. */
  before?: string;
  after?: string;
  repository?: { full_name?: string };
  resource?: {
    repository?: { name?: string; project?: { name?: string } };
    /** Azure DevOps reports one entry per pushed ref. */
    refUpdates?: { oldObjectId?: string; newObjectId?: string }[];
  };
}

/** The commit ranges a push event carries. */
function pushedRefs(kind: string, payload: WebhookPayload): Array<{ before: string; after: string }> {
  if (kind === 'push' && payload.before && payload.after) return [{ before: payload.before, after: payload.after }];
  if (kind === 'git.push') {
    return (payload.resource?.refUpdates ?? [])
      .filter((update) => update.oldObjectId && update.newObjectId)
      .map((update) => ({ before: update.oldObjectId!, after: update.newObjectId! }));
  }
  return [];
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

  const body = await readText(ctx.req, 5_000_000);
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
  let payload: WebhookPayload = {};
  try {
    payload = JSON.parse(body) as WebhookPayload;
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

  const client = clientFor(connection);
  await handleRepositoryEvent({
    kind,
    repo,
    reviewSetIds: rows.map((row) => row.review_set_id),
    pushes: pushedRefs(kind, payload),
    markClient: client,
    commentClient: client,
    commentConnectionId: connection.id,
    reason: 'forge',
  });
  return json({ ok: true });
}

/**
 * The GitHub App's webhook: one endpoint for every installed repository. The
 * installation events attach or clear the installation on the matching
 * connections; repository events reach the review sets that track the repo.
 */
export async function githubAppWebhook(ctx: Ctx): Promise<Response> {
  const body = await readText(ctx.req, 5_000_000);
  if (!verifyAppSignature(body, ctx.req.headers.get('x-hub-signature-256') ?? '')) {
    throw new HttpError(401, 'Invalid webhook signature');
  }
  const event = ctx.req.headers.get('x-github-event') ?? '';
  let payload: WebhookPayload & { action?: string; installation?: { id?: number; account?: { login?: string } } };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    throw new HttpError(400, 'Webhook body must be JSON');
  }

  if (event === 'installation' || event === 'installation_repositories') {
    syncInstallation(payload);
    // A reinstall changes the installation id every repository resolves to.
    forgetRepoInstallations();
    void refreshGithubInstallations();
    return json({ ok: true });
  }
  if (!commentEvents.has(event) && !stateEvents.has(event)) return json({ ok: true, ignored: event });

  const repo = payload.repository?.full_name ?? '';
  if (!repo) return json({ ok: true, ignored: 'no repository' });
  const rows = db
    .query<{ review_set_id: number }, [string, string]>(
      `SELECT DISTINCT rsr.review_set_id FROM review_set_repos rsr
       JOIN forge_connections fc ON fc.id = rsr.connection_id
       WHERE fc.kind = 'github' AND (rsr.repo = ? OR rsr.repo LIKE '%/' || ?)`,
    )
    .all(repo, repo);
  if (rows.length === 0) return json({ ok: true, ignored: 'no review set' });

  const installationId = String(payload.installation?.id ?? '');
  let client: GithubClient | null = null;
  if (pushedRefs(event, payload).length > 0 || commentEvents.has(event)) {
    try {
      client = new GithubClient(await installationToken(installationId), { refresh: () => installationToken(installationId) });
    } catch (error) {
      console.error('Could not use the GitHub installation for a webhook:', error);
    }
  }
  await handleRepositoryEvent({
    kind: event,
    repo,
    reviewSetIds: rows.map((row) => row.review_set_id),
    pushes: pushedRefs(event, payload),
    markClient: client,
    commentClient: client,
    reason: 'github-app',
  });
  return json({ ok: true });
}

function syncInstallation(payload: { action?: string; installation?: { id?: number; account?: { login?: string } } }): void {
  const id = String(payload.installation?.id ?? '');
  const login = payload.installation?.account?.login ?? '';
  if (!id) return;
  if (payload.action === 'deleted') {
    db.run("UPDATE forge_connections SET installation_id = NULL WHERE kind = 'github' AND installation_id = ?", [id]);
    forgetInstallation(id);
    invalidateForgeCaches();
    return;
  }
  if (!login) return;
  db.run("UPDATE forge_connections SET installation_id = ? WHERE kind = 'github' AND lower(login) = lower(?)", [id, login]);
  invalidateForgeCaches();
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
    const register = client?.registerWebhook?.bind(client);
    // Azure DevOps service hooks are created by hand, but still need a secret
    // for mureview to verify their deliveries.
    if (!register && connection.kind !== 'ado') continue;
    // The GitHub App delivers webhooks for its installations already.
    if (connection.kind === 'github' && connection.installation_id) continue;
    let secret = connection.webhook_secret;
    if (!secret) {
      secret = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
      db.run('UPDATE forge_connections SET webhook_secret = ? WHERE id = ?', [secret, connection.id]);
    }
    if (!register) continue;
    const url = `${config.baseUrl}/api/webhooks/forge/${connection.id}`;
    await register(entry.repo, url, secret);
  }
}

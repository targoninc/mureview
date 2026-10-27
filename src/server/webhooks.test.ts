import { createHmac } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import { encrypt } from './crypto';
import { db } from './db';
import type { Ctx } from './router';
import { ensureWebhooksForReviewSet, forgeWebhook } from './webhooks';

const connectionId = 90_001;

function connect(secret: string): void {
  db.run(
    "INSERT INTO forge_connections (id, user_id, kind, base_url, access_token, login, webhook_secret) VALUES (?, 1, 'github', 'https://github.com', 'token', 'me', ?)",
    [connectionId, secret],
  );
}

function webhook(body: string, secret: string): Ctx {
  const url = new URL(`http://localhost/api/webhooks/forge/${connectionId}`);
  return {
    req: new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      body,
    }),
    url,
    path: `/api/webhooks/forge/${connectionId}`,
    params: { connectionId: String(connectionId) },
    user: null,
  };
}

afterAll(() => {
  db.run('DELETE FROM forge_connections WHERE id = ?', [connectionId]);
  db.run('DELETE FROM review_sets WHERE id = 90002');
  db.run('DELETE FROM forge_connections WHERE id = 90002');
});

test('webhook signatures are verified', async () => {
  const body = JSON.stringify({ repository: { full_name: 'acme/none' } });

  connect('secret-one');
  expect((await forgeWebhook(webhook(body, 'secret-one'))).status).toBe(200);
  await expect(forgeWebhook(webhook(body, 'wrong'))).rejects.toMatchObject({ status: 401 });

  db.run('UPDATE forge_connections SET webhook_secret = ? WHERE id = ?', ['secret-two', connectionId]);
  expect((await forgeWebhook(webhook(body, 'secret-two'))).status).toBe(200);
});

test('Azure DevOps review sets get a webhook secret even though service hooks are manual', async () => {
  db.run(
    "INSERT INTO forge_connections (id, user_id, kind, base_url, access_token, login) VALUES (90002, 1, 'ado', 'https://dev.azure.com/acme', ?, 'me')",
    [encrypt('token')],
  );
  db.run(
    "INSERT INTO review_sets (id, owner_id, name, mode, branch_regex, target_branch) VALUES (90002, 1, 'ADO hooks', 'pattern', '^feature$', 'main')",
  );
  db.run("INSERT INTO review_set_repos (review_set_id, connection_id, repo, position) VALUES (90002, 90002, 'acme/repo', 0)");
  await ensureWebhooksForReviewSet(90002);
  const row = db.query<{ webhook_secret: string | null }, []>('SELECT webhook_secret FROM forge_connections WHERE id = 90002').get();
  expect(row?.webhook_secret).toBeTruthy();
});

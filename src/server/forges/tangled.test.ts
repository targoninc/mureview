import { afterAll, expect, test } from 'bun:test';
import { TangledClient } from './tangled';

const ownerDid = 'did:plc:owner0000000000000000000';
const repoDid = 'did:plc:repo00000000000000000000';

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown> | undefined;
}

const calls: Call[] = [];
const realFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
});

const json = (data: unknown, status = 200) => Response.json(data, { status });

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  calls.push({
    url: url.toString(),
    method: init?.method ?? 'GET',
    authorization: headers.get('authorization'),
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
  });

  if (url.host === 'plc.directory') {
    const did = url.pathname.slice(1);
    if (did === ownerDid) {
      return json({ service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.example' }], alsoKnownAs: ['at://owner.test'] });
    }
    if (did === repoDid) {
      return json({ service: [{ id: '#atproto_pds', serviceEndpoint: 'https://knot.example' }], alsoKnownAs: [] });
    }
    return json({}, 404);
  }

  if (url.host === 'pds.example') {
    if (url.pathname === '/xrpc/com.atproto.repo.getRecord' && url.searchParams.get('collection') === 'sh.tangled.repo') {
      return json({ value: { knot: 'knot.example', repoDid } });
    }
    return json({}, 400);
  }

  if (url.host === 'knot.example') {
    const collection = url.searchParams.get('collection');
    if (url.pathname === '/xrpc/sh.tangled.repo.branch') {
      const name = url.searchParams.get('name') ?? '';
      if (name === 'main') return json({ name, hash: 'a'.repeat(40) });
      if (name === 'feature') return json({ name, hash: 'b'.repeat(40) });
      return json({ error: 'RefNotFound', message: 'no such branch' }, 400);
    }
    if (url.pathname === '/xrpc/sh.tangled.repo.compare') {
      return json({ rev1: 'a'.repeat(40), rev2: 'b'.repeat(40), merge_base: 'a'.repeat(40), format_patch: [], combined_patch: null });
    }
    if (url.pathname === '/xrpc/sh.tangled.repo.log') {
      return json({ commits: [{ this: 'd'.repeat(40), message: 'fix the thing\n\nmore', author: { Name: 'Ada', When: '2026-01-01T00:00:00Z' } }] });
    }
    if (url.pathname === '/xrpc/com.atproto.repo.createRecord') {
      const body = (init?.body ? JSON.parse(String(init.body)) : {}) as { collection?: string };
      if (body.collection === 'org.tangled.track.ticket') return json({ uri: `at://${repoDid}/org.tangled.track.ticket/3ticket`, cid: 'bafyticket' });
      if (body.collection === 'org.tangled.review.patch') return json({ uri: `at://${repoDid}/org.tangled.review.patch/bafypatch`, cid: 'bafypatch' });
      if (body.collection === 'org.tangled.feed.comment') return json({ uri: `at://${repoDid}/org.tangled.feed.comment/3comment`, cid: 'bafycomment' });
    }
    if (url.pathname === '/xrpc/com.atproto.repo.getRecord') {
      if (collection === 'org.tangled.track.ticket') {
        return json({ uri: `at://${repoDid}/org.tangled.track.ticket/3ticket`, cid: 'bafyticket', value: {} });
      }
      if (collection === 'org.tangled.feed.comment') {
        return json({ uri: `at://${repoDid}/org.tangled.feed.comment/3parent`, cid: 'bafyparent', value: {} });
      }
      return json({}, 400);
    }
    if (url.pathname === '/xrpc/com.atproto.repo.listRecords') {
      if (collection === 'org.tangled.review.patch') {
        return json({
          records: [
            { uri: `at://${repoDid}/org.tangled.review.patch/bafyold`, value: { ticket: '3ticket', createdAt: '2026-01-01T00:00:00Z' } },
            { uri: `at://${repoDid}/org.tangled.review.patch/bafypatch`, value: { ticket: '3ticket', createdAt: '2026-01-02T00:00:00Z' } },
            { uri: `at://${repoDid}/org.tangled.review.patch/bafyother`, value: { ticket: '3other', createdAt: '2026-01-03T00:00:00Z' } },
          ],
        });
      }
      if (collection === 'org.tangled.feed.comment') {
        return json({
          records: [
            {
              uri: `at://${repoDid}/org.tangled.feed.comment/3comment`,
              value: {
                subject: { uri: `at://${repoDid}/org.tangled.track.ticket/3ticket`, cid: 'bafyticket' },
                body: { text: 'looks good' },
                createdAt: '2026-01-02T00:00:00Z',
                'x-tngl-editor': ownerDid,
              },
            },
            {
              uri: `at://${repoDid}/org.tangled.feed.comment/3elsewhere`,
              value: {
                subject: { uri: `at://${repoDid}/org.tangled.track.ticket/3other`, cid: 'bafyother' },
                body: { text: 'unrelated' },
                createdAt: '2026-01-03T00:00:00Z',
              },
            },
          ],
        });
      }
    }
    if (url.pathname === '/xrpc/sh.tangled.repo.pull.merge') {
      return json({ tip: 'c'.repeat(40), merged: [] });
    }
  }
  return json({}, 404);
}) as unknown as typeof fetch;

const repo = `${ownerDid}/core`;

const client = new TangledClient('https://tangled.org', ownerDid, {
  did: ownerDid,
  serviceAuth: async ({ aud, lxm }) => `token:${aud}:${lxm}`,
});

test('creates a ticket and a patch for a pull request', async () => {
  calls.length = 0;
  const pull = await client.ensurePullRequest(repo, 'main', 'feature', 'Merge feature', 'Review set: X', 'https://mureview.example/review-sets/1');
  expect(pull).toEqual({ ref: '3ticket', created: true });

  const ticket = calls.find((call) => call.body?.collection === 'org.tangled.track.ticket');
  expect(ticket?.body?.repo).toBe(repoDid);
  const ticketRecord = ticket?.body?.record as Record<string, unknown>;
  expect(ticketRecord.title).toEqual({ text: 'Merge feature' });
  expect(ticketRecord.state).toBe('open');
  expect(ticketRecord.targetBranch).toBe('main');
  expect((ticketRecord.body as { text: string }).text).toContain('Open in mureview: https://mureview.example/review-sets/1');
  expect(ticket?.authorization).toBe(`Bearer token:${repoDid}:com.atproto.repo.createRecord`);

  const patch = calls.find((call) => call.body?.collection === 'org.tangled.review.patch');
  const patchRecord = patch?.body?.record as Record<string, unknown>;
  expect(patchRecord.ticket).toBe('3ticket');
  expect(patchRecord.base).toEqual({ oid: 'a'.repeat(40) });
  expect(patchRecord.head).toEqual({ oid: 'b'.repeat(40) });
});

test('posts comments with a strongRef subject and the location in the body', async () => {
  calls.length = 0;
  const posted = await client.postReviewComment(repo, '3ticket', { body: 'nit', path: 'src/a.ts', line: 3, side: 'additions' });
  expect(posted).toEqual({ kind: 'pull-request', id: '3comment' });

  const comment = calls.find((call) => call.body?.collection === 'org.tangled.feed.comment');
  const record = comment?.body?.record as Record<string, unknown>;
  expect(record.subject).toEqual({ uri: `at://${repoDid}/org.tangled.track.ticket/3ticket`, cid: 'bafyticket' });
  expect((record.body as { text: string }).text).toBe('src/a.ts:3\n\nnit');
});

test('replies reference the parent comment', async () => {
  calls.length = 0;
  await client.postReviewComment(repo, '3ticket', { body: 're', path: 'src/a.ts', line: 3, side: 'additions', replyTo: '3parent' });
  const comment = calls.find((call) => call.body?.collection === 'org.tangled.feed.comment');
  const record = comment?.body?.record as Record<string, unknown>;
  expect(record.replyTo).toEqual({ uri: `at://${repoDid}/org.tangled.feed.comment/3parent`, cid: 'bafyparent' });
});

test('merges the latest patch of the ticket', async () => {
  calls.length = 0;
  const message = await client.mergePullRequest(repo, '3ticket', 'ignored');
  expect(message).toContain('3ticket');
  const merge = calls.find((call) => call.url.includes('pull.merge'));
  expect(merge?.body).toEqual({ repo: repoDid, rkey: 'bafypatch' });
  expect(merge?.authorization).toBe(`Bearer token:${repoDid}:sh.tangled.repo.pull.merge`);
});

test('lists only the comments of this pull request', async () => {
  const comments = await client.listComments(repo, '3ticket');
  expect(comments).toHaveLength(1);
  expect(comments[0]).toMatchObject({ id: '3comment', body: 'looks good' });
  expect(comments[0].author.name).toBe('owner.test');
});

test('commit links point at the tangled web ui', async () => {
  const commits = await client.listCommits(repo, { headSha: 'b'.repeat(40), limit: 5 });
  expect(commits[0]).toMatchObject({ sha: 'd'.repeat(40), author: 'Ada' });
  expect(commits[0].url).toBe(`https://tangled.org/${repo}/commit/${'d'.repeat(40)}`);
});

test('writes ask for an atproto sign-in without a session', async () => {
  const anonymous = new TangledClient('https://tangled.org', ownerDid);
  await expect(anonymous.ensurePullRequest(repo, 'main', 'feature', 'x')).rejects.toThrow('sign in with atproto');
});

test('a knot that does not accept records is named before any write', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    if (url.host === 'plc.directory') {
      const did = url.pathname.slice(1);
      if (did === ownerDid) return Response.json({ service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.example' }], alsoKnownAs: [] });
      if (did === repoDid) return Response.json({ service: [{ id: '#atproto_pds', serviceEndpoint: 'https://knot-norecords.example' }], alsoKnownAs: [] });
      return Response.json({}, { status: 404 });
    }
    if (url.host === 'pds.example' && url.pathname === '/xrpc/com.atproto.repo.getRecord') {
      return Response.json({ value: { knot: 'knot-norecords.example', repoDid } });
    }
    if (url.pathname === '/xrpc/org.tangled.knot.describeKnot') {
      return Response.json({ did: repoDid, version: 'v1.0.0', capabilities: [] });
    }
    if (url.pathname === '/xrpc/sh.tangled.repo.branch') return Response.json({ name: 'main', hash: 'a'.repeat(40) });
    if (url.pathname === '/xrpc/sh.tangled.repo.compare') {
      return Response.json({ rev1: 'a'.repeat(40), rev2: 'b'.repeat(40), merge_base: 'a'.repeat(40), format_patch: [], combined_patch: null });
    }
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  try {
    const client = new TangledClient('https://tangled.org', ownerDid, {
      did: ownerDid,
      serviceAuth: async () => 'token',
    });
    await expect(client.ensurePullRequest(`${ownerDid}/norecords`, 'main', 'feature', 'x')).rejects.toThrow("doesn't accept Tangled records");
  } finally {
    globalThis.fetch = previous;
  }
});

test('an older knot build is explained instead of surfacing a bare 404', async () => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.host === 'plc.directory') {
      const did = url.pathname.slice(1);
      if (did === ownerDid) return Response.json({ service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.example' }], alsoKnownAs: [] });
      if (did === repoDid) return Response.json({ service: [{ id: '#atproto_pds', serviceEndpoint: 'https://knot-old.example' }], alsoKnownAs: [] });
      return Response.json({}, { status: 404 });
    }
    if (url.host === 'pds.example' && url.pathname === '/xrpc/com.atproto.repo.getRecord') {
      return Response.json({ value: { knot: 'knot-old.example', repoDid } });
    }
    // An older knot: no capability list, and the record route is not there.
    if (url.pathname === '/xrpc/org.tangled.knot.describeKnot') return new Response('', { status: 404 });
    if (url.pathname === '/xrpc/sh.tangled.repo.branch') return Response.json({ name: 'main', hash: 'a'.repeat(40) });
    if (url.pathname === '/xrpc/sh.tangled.repo.compare') {
      return Response.json({ rev1: 'a'.repeat(40), rev2: 'b'.repeat(40), merge_base: 'a'.repeat(40), format_patch: [], combined_patch: null });
    }
    if (url.pathname === '/xrpc/com.atproto.repo.createRecord') return Response.json({}, { status: 404 });
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  try {
    const client = new TangledClient('https://tangled.org', ownerDid, {
      did: ownerDid,
      serviceAuth: async () => 'token',
    });
    await expect(client.ensurePullRequest(repo, 'main', 'feature', 'x')).rejects.toThrow('older knot build');
    // The service token is still minted; the knot is what refuses.
    expect(calls).toContain('/xrpc/com.atproto.repo.createRecord');
  } finally {
    globalThis.fetch = previous;
  }
});

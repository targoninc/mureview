import { expect, test } from 'bun:test';
import { db } from './db';
import {
  createMcpKey,
  deleteMcpKey,
  listMcpKeys,
  lookupMcpKey,
  mcpEndpoint,
} from './mcp';
import type { Ctx } from './router';

function addUser(name: string): number {
  const inserted = db.run('INSERT INTO users (name) VALUES (?)', [name]);
  return Number(inserted.lastInsertRowid);
}

function addReviewSet(ownerId: number, name: string): number {
  const inserted = db.run(
    "INSERT INTO review_sets (owner_id, name, mode, branch_regex, target_branch) VALUES (?, ?, 'pattern', '^feature$', 'main')",
    [ownerId, name],
  );
  return Number(inserted.lastInsertRowid);
}

function ctxFor(body: unknown, token?: string, method = 'POST'): Ctx {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = new URL('http://localhost/api/mcp');
  return {
    req: new Request(url, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined }),
    url,
    path: '/api/mcp',
    params: {},
    user: null,
  };
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test-agent', version: '1.0.0' },
  },
};

test('MCP keys are hashed, hidden until tools are listed, and hard deleted', async () => {
  const userId = addUser('mcp-owner');
  const reviewSetId = addReviewSet(userId, 'MCP review');
  const key = createMcpKey(userId);

  expect(lookupMcpKey(key.token)?.user_id).toBe(userId);
  expect(lookupMcpKey(`${key.token}x`)).toBeNull();
  expect(listMcpKeys(userId)).toEqual([]);

  const init = await mcpEndpoint(ctxFor(initialize, key.token));
  expect(init.status).toBe(200);
  const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
  expect(initBody.result.serverInfo.name).toBe('mureview');

  const list = await mcpEndpoint(
    ctxFor({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, key.token),
  );
  expect(list.status).toBe(200);
  const listBody = (await list.json()) as { result: { tools: Array<{ name: string }> } };
  expect(listBody.result.tools.map((tool) => tool.name)).toContain('list_review_sets');

  const keys = listMcpKeys(userId);
  expect(keys).toHaveLength(1);
  expect(keys[0]!.id).toBe(key.id);
  expect(keys[0]!.clientName).toBe('test-agent');
  expect(keys[0]!.usedAt).toBeTruthy();

  const unused = createMcpKey(userId);
  expect(listMcpKeys(userId)).toHaveLength(1);
  expect(lookupMcpKey(unused.token)?.user_id).toBe(userId);

  const call = await mcpEndpoint(
    ctxFor(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_review_sets', arguments: {} },
      },
      key.token,
    ),
  );
  expect(call.status).toBe(200);
  const callBody = (await call.json()) as { result: { content: Array<{ text: string }> } };
  expect(callBody.result.content[0]!.text).toContain('MCP review');
  expect(callBody.result.content[0]!.text).toContain(String(reviewSetId));

  expect(deleteMcpKey(userId, key.id)).toBe(true);
  expect(deleteMcpKey(userId, key.id)).toBe(false);
  expect(lookupMcpKey(key.token)).toBeNull();
  expect(listMcpKeys(userId)).toEqual([]);
  expect((await mcpEndpoint(ctxFor(initialize, key.token))).status).toBe(401);
});

test('MCP requests without a valid key are rejected', async () => {
  expect((await mcpEndpoint(ctxFor(initialize))).status).toBe(401);
  expect((await mcpEndpoint(ctxFor(initialize, 'mrv_not-a-key'))).status).toBe(401);
  expect((await mcpEndpoint(ctxFor(initialize, 'mrv_not-a-key', 'GET'))).status).toBe(405);
});

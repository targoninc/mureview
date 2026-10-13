import { afterAll, expect, test } from 'bun:test';
import { AdoClient } from './ado';

interface AdoCommit {
  commitId: string;
  comment: string;
  author: { name: string; date: string };
  remoteUrl: string;
}

const commit = (id: number, date: string): AdoCommit => ({
  commitId: `sha${String(id).padStart(4, '0')}`,
  comment: `commit ${id}\n\nmore detail`,
  author: { name: `author ${id}`, date },
  remoteUrl: `https://dev.azure.com/acme/Proj/_git/Repo/commit/${id}`,
});

const requests: string[] = [];

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    requests.push(url.pathname + url.search);

    if (url.pathname === '/Proj/_apis/git/repositories/Repo/pullrequests/7/commits') {
      const skip = Number(url.searchParams.get('$skip') ?? 0);
      if (skip === 0) {
        const page = Array.from({ length: 100 }, (_, index) => commit(index + 20, '2026-01-02T00:00:00Z'));
        return Response.json(page);
      }
      return Response.json(Array.from({ length: 20 }, (_, index) => commit(index, '2026-01-01T00:00:00Z')));
    }

    if (url.pathname === '/Proj/_apis/git/repositories/Repo/pullrequests/8/commits') {
      return Response.json({ message: 'not found' }, { status: 404 });
    }

    if (url.pathname === '/Proj/_apis/git/repositories/Repo/commits') {
      if (url.searchParams.get('continuationToken')) {
        return Response.json({ value: [commit(1, '2026-01-01T00:00:00Z')] });
      }
      return Response.json(
        { count: 3, value: [commit(4, '2026-01-04T00:00:00Z'), commit(3, '2026-01-03T00:00:00Z'), commit(2, '2026-01-02T00:00:00Z')] },
        { headers: { 'x-ms-continuationtoken': 'next' } },
      );
    }

    return Response.json({ message: 'unexpected request' }, { status: 500 });
  },
});

const client = new AdoClient(`http://localhost:${server.port}`, 'token');

test('uses the pull request commits endpoint and pages through them, oldest first', async () => {
  requests.length = 0;
  const commits = await client.listCommits('Proj/Repo', { headSha: 'head', pullRequest: 7, limit: 200 });

  expect(commits).toHaveLength(120);
  expect(commits[0]!.sha).toBe('sha0000');
  expect(commits.at(-1)!.sha).toBe('sha0119');
  expect(commits[0]!.message).toBe('commit 0');
  expect(requests).toEqual([
    '/Proj/_apis/git/repositories/Repo/pullrequests/7/commits?$top=100&$skip=0&api-version=7.1',
    '/Proj/_apis/git/repositories/Repo/pullrequests/7/commits?$top=100&$skip=100&api-version=7.1',
  ]);
});

test('falls back to the branch comparison when the pull request is gone', async () => {
  requests.length = 0;
  const commits = await client.listCommits('Proj/Repo', { headSha: 'head', baseSha: 'base', pullRequest: 8 });

  expect(commits.map((entry) => entry.sha)).toEqual(['sha0001', 'sha0002', 'sha0003', 'sha0004']);
  expect(requests[0]).toContain('/pullrequests/8/commits');
  expect(requests[1]).toContain('searchCriteria.compareVersion.version=base');
  expect(requests).toHaveLength(3);
});

afterAll(() => {
  server.stop(true);
});

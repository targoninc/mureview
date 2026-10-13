import { test, expect } from 'bun:test';
import type { Comment, RepoStatus } from '../../shared/types';
import { forgeCommentLink } from './format';

const comment = (overrides: Partial<Comment>): Comment => ({
  id: 1,
  prId: 1,
  author: { name: 'someone', avatarUrl: '' },
  connectionId: 1,
  repo: 'acme/app',
  path: null,
  line: null,
  side: null,
  body: 'hello',
  synced: true,
  source: 'forge',
  forgeCommentId: '42',
  createdAt: '2026-01-01 00:00:00',
  ...overrides,
});

const repo = (kind: RepoStatus['kind'], url: string): RepoStatus => ({
  connectionId: 1,
  kind,
  host: 'example.com',
  org: null,
  repo: 'acme/app',
  accessible: true,
  matches: ['feature'],
  branch: 'feature',
  targetExists: true,
  state: 'open',
  pullRequest: { number: 7, url },
});

test('github links use discussion and issue anchors', () => {
  const repos = [repo('github', 'https://github.com/acme/app/pull/7')];
  expect(forgeCommentLink(repos, comment({ path: 'src/a.ts', line: 3 }))?.url).toBe(
    'https://github.com/acme/app/pull/7#discussion_r42',
  );
  expect(forgeCommentLink(repos, comment({}))?.url).toBe('https://github.com/acme/app/pull/7#issuecomment-42');
});

test('forgejo links use the files view for anchored comments', () => {
  const repos = [repo('forgejo', 'https://code.example.com/acme/app/pulls/7')];
  expect(forgeCommentLink(repos, comment({ path: 'src/a.ts', line: 3 }))?.url).toBe(
    'https://code.example.com/acme/app/pulls/7/files#issuecomment-42',
  );
  expect(forgeCommentLink(repos, comment({}))?.url).toBe('https://code.example.com/acme/app/pulls/7#issuecomment-42');
});

test('azure devops links use the discussion id of a thread', () => {
  const repos = [repo('ado', 'https://dev.azure.com/acme/app/_git/app/pullrequest/7')];
  expect(forgeCommentLink(repos, comment({ forgeCommentId: '9:4', path: 'src/a.ts', line: 3 }))?.url).toBe(
    'https://dev.azure.com/acme/app/_git/app/pullrequest/7?discussionId=9&_a=files',
  );
  expect(forgeCommentLink(repos, comment({ forgeCommentId: '9:4' }))?.url).toBe(
    'https://dev.azure.com/acme/app/_git/app/pullrequest/7?discussionId=9&_a=discussion',
  );
});

test('comments without a forge id, repo or pull request have no link', () => {
  const repos = [repo('github', 'https://github.com/acme/app/pull/7')];
  expect(forgeCommentLink(repos, comment({ forgeCommentId: null }))).toBeNull();
  expect(forgeCommentLink(repos, comment({ repo: 'acme/other' }))).toBeNull();
  expect(forgeCommentLink([], comment({}))).toBeNull();
});

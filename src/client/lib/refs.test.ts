import { test, expect } from 'bun:test';
import type { RepoStatus } from '../../shared/types';
import { findItemRefs } from './refs';

const repo = (overrides: Partial<RepoStatus>): RepoStatus => ({
  connectionId: 1,
  kind: 'github',
  host: 'github.com',
  org: null,
  repo: 'acme/app',
  accessible: true,
  matches: [],
  branch: null,
  targetExists: true,
  state: 'open',
  ...overrides,
});

test('azure devops renders pull requests and work items', () => {
  const ado = repo({ kind: 'ado', host: 'dev.azure.com', org: 'quibig', repo: 'NMD/SST_Massenimport' });
  const refs = findItemRefs('Fixed with !42 and tracked as #1337.', ado);

  expect(refs.map((ref) => ref.text)).toEqual(['!42', '#1337']);
  expect(refs[0]!.url).toBe('https://dev.azure.com/quibig/NMD/_git/SST_Massenimport/pullrequest/42');
  expect(refs[0]!.title).toBe('Pull request 42');
  expect(refs[1]!.url).toBe('https://dev.azure.com/quibig/NMD/_workitems/edit/1337');
  expect(refs[1]!.title).toBe('Work item 1337');
});

test('github and forgejo render issues and pull requests', () => {
  const github = findItemRefs('See #12 and #13.', repo({}));
  expect(github.map((ref) => ref.url)).toEqual(['https://github.com/acme/app/issues/12', 'https://github.com/acme/app/issues/13']);

  const forgejo = findItemRefs('See #12.', repo({ kind: 'forgejo', host: 'git.example.com' }));
  expect(forgejo[0]!.url).toBe('https://git.example.com/acme/app/issues/12');
});

test('offsets survive other text and markdown images are not references', () => {
  const refs = findItemRefs('![image](https://x/y.png) see #7', repo({ kind: 'forgejo' }));
  expect(refs).toHaveLength(1);
  expect(refs[0]!.text).toBe('#7');
  expect('![image](https://x/y.png) see #7'.slice(refs[0]!.start, refs[0]!.end)).toBe('#7');
});

test('no repository context means no links', () => {
  expect(findItemRefs('See #12.', undefined)).toEqual([]);
});

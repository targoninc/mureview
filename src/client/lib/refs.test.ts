import { test, expect } from 'bun:test';
import type { RepoStatus } from '../../shared/types';
import { fallbackRefUrl, findItemRefs } from './refs';

const repo = (overrides: Partial<RepoStatus>): RepoStatus => ({
  connectionId: 1,
  kind: 'github',
  host: 'github.com',
  org: null,
  repo: 'acme/app',
  accessible: true,
  matches: [],
  branch: null,
  target: 'main',
  targetExists: true,
  state: 'open',
  ...overrides,
});

test('azure devops finds pull request and work item references', () => {
  const ado = repo({ kind: 'ado', host: 'dev.azure.com', org: 'quibig', repo: 'NMD/SST_Massenimport' });
  const refs = findItemRefs('Fixed with !42 and tracked as #1337.', ado);

  expect(refs.map((ref) => [ref.text, ref.type, ref.id])).toEqual([
    ['!42', 'pr', '42'],
    ['#1337', 'work', '1337'],
  ]);
  expect(fallbackRefUrl(refs[0]!, ado)).toBe('https://dev.azure.com/quibig/NMD/_git/SST_Massenimport/pullrequest/42');
  expect(fallbackRefUrl(refs[1]!, ado)).toBe('https://dev.azure.com/quibig/NMD/_workitems/edit/1337');
});

test('github and forgejo find issue or pull request references', () => {
  const github = repo({});
  const refs = findItemRefs('See #12 and #13.', github);
  expect(refs.map((ref) => ref.type)).toEqual(['issue', 'issue']);
  expect(refs.map((ref) => fallbackRefUrl(ref, github))).toEqual([
    'https://github.com/acme/app/issues/12',
    'https://github.com/acme/app/issues/13',
  ]);

  const forgejo = repo({ kind: 'forgejo', host: 'git.example.com' });
  expect(fallbackRefUrl(findItemRefs('See #12.', forgejo)[0]!, forgejo)).toBe('https://git.example.com/acme/app/issues/12');
});

test('offsets survive other text and markdown images are not references', () => {
  const refs = findItemRefs('![image](https://x/y.png) see #7', repo({ kind: 'forgejo' }));
  expect(refs).toHaveLength(1);
  expect(refs[0]!.text).toBe('#7');
  expect('![image](https://x/y.png) see #7'.slice(refs[0]!.start, refs[0]!.end)).toBe('#7');
});

test('no repository context means no references', () => {
  expect(findItemRefs('See #12.', undefined)).toEqual([]);
});

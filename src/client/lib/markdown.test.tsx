import { expect, test } from 'bun:test';
import type { RepoStatus } from '../../shared/types';
import { MENTION_SCHEME, REF_SCHEME, preprocessBody } from './markdown';

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
  position: 0,
  targetExists: true,
  state: 'open',
  ...overrides,
});

test('rewrites references into chip links', () => {
  const body = 'Fixes #12 and !34 for **real**.';
  const ado = repo({ kind: 'ado', host: 'dev.azure.com', org: 'quibig', repo: 'NMD/SST_Massenimport' });
  expect(preprocessBody(body, ado)).toBe(`Fixes [#12](${REF_SCHEME}work:12) and [!34](${REF_SCHEME}pr:34) for **real**.`);
  expect(preprocessBody('See #12.', repo({}))).toBe(`See [#12](${REF_SCHEME}issue:12).`);
});

test('rewrites azure devops mentions into chip links', () => {
  const ado = repo({ kind: 'ado' });
  const id = '64abb352-f11a-6fb6-9f99-c52a00fe1b6f';
  expect(preprocessBody(`Thanks @<${id}>!`, ado)).toBe(`Thanks [@<${id}>](${MENTION_SCHEME}${id})!`);
});

test('leaves code spans and fenced blocks alone', () => {
  const status = repo({});
  expect(preprocessBody('use `#12` not #13', status)).toBe(`use \`#12\` not [#13](${REF_SCHEME}issue:13)`);
  const fenced = 'before\n```sh\n# not a reference\n```\nafter #7';
  expect(preprocessBody(fenced, status)).toBe(`before\n\`\`\`sh\n# not a reference\n\`\`\`\nafter [#7](${REF_SCHEME}issue:7)`);
});

test('no repository context leaves the body untouched', () => {
  expect(preprocessBody('See #12.', undefined)).toBe('See #12.');
});

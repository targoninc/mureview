import { describe, expect, test } from 'bun:test';
import type { ForgeConnectionRow } from './db';
import { parsePullRequestLink, parsePullRequestLinks } from './pullRequestLinks';

function connection(id: number, kind: 'github' | 'forgejo' | 'ado', baseUrl: string): ForgeConnectionRow {
  return { id, kind, base_url: baseUrl } as ForgeConnectionRow;
}

const connections = [
  connection(1, 'github', 'https://github.com'),
  connection(2, 'forgejo', 'https://git.example.com'),
  connection(3, 'forgejo', 'https://git.example.com/gitea'),
  connection(4, 'ado', 'https://dev.azure.com/acme'),
];

describe('parsePullRequestLink', () => {
  test('reads GitHub pull request URLs', () => {
    const link = parsePullRequestLink('https://github.com/acme/repo/pull/42/files', connections);
    expect(link.connection.id).toBe(1);
    expect(link.repo).toBe('acme/repo');
    expect(link.ref).toBe('42');
  });

  test('reads Forgejo pull request URLs, including a scoped base path', () => {
    const plain = parsePullRequestLink('https://git.example.com/acme/repo/pulls/7', connections);
    expect(plain.connection.id).toBe(2);
    expect(plain.repo).toBe('acme/repo');
    expect(plain.ref).toBe('7');

    const scoped = parsePullRequestLink('https://git.example.com/gitea/acme/repo/pulls/8', connections);
    expect(scoped.connection.id).toBe(3);
    expect(scoped.ref).toBe('8');
  });

  test('reads Azure DevOps pull request URLs', () => {
    const link = parsePullRequestLink('https://dev.azure.com/acme/project/_git/repo/pullrequest/9', connections);
    expect(link.connection.id).toBe(4);
    expect(link.repo).toBe('project/repo');
    expect(link.ref).toBe('9');
  });

  test('rejects URLs for a forge that is not connected', () => {
    expect(() => parsePullRequestLink('https://github.com/acme/repo/pull/42', connections.slice(1))).toThrow(
      'No forge connection matches',
    );
  });
});

test('parses and deduplicates pasted pull request lists', () => {
  const links = parsePullRequestLinks(
    'https://github.com/acme/repo/pull/1\nhttps://github.com/acme/repo/pull/1,https://git.example.com/acme/repo/pulls/2',
    connections,
  );
  expect(links.map((link) => `${link.repo}#${link.ref}`)).toEqual(['acme/repo#1', 'acme/repo#2']);
});

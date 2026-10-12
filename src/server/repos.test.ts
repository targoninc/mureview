import { describe, expect, test } from 'bun:test';
import { normalizeRepo, parseRepoList } from './repos';

describe('normalizeRepo', () => {
  test('accepts owner/name', () => {
    expect(normalizeRepo('targoninc/mureview')).toBe('targoninc/mureview');
  });

  test('accepts GitHub URLs and .git suffixes', () => {
    expect(normalizeRepo('https://github.com/targoninc/mureview')).toBe('targoninc/mureview');
    expect(normalizeRepo('https://github.com/targoninc/mureview.git')).toBe('targoninc/mureview');
    expect(normalizeRepo('  github.com/targoninc/mureview/  ')).toBe('targoninc/mureview');
  });

  test('rejects invalid values', () => {
    expect(normalizeRepo('not a repo')).toBeNull();
    expect(normalizeRepo('')).toBeNull();
    expect(normalizeRepo('owner/name/extra')).toBeNull();
  });
});

describe('parseRepoList', () => {
  test('deduplicates and normalizes', () => {
    const result = parseRepoList(['targoninc/a', 'targoninc/a', 'https://github.com/targoninc/b.git', '']);
    expect(result.repos).toEqual(['targoninc/a', 'targoninc/b']);
    expect(result.invalid).toEqual([]);
  });

  test('collects invalid entries', () => {
    const result = parseRepoList(['targoninc/a', 'nope']);
    expect(result.repos).toEqual(['targoninc/a']);
    expect(result.invalid).toEqual(['nope']);
  });
});

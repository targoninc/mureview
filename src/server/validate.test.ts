import { describe, expect, test } from 'bun:test';
import { compileRegex, matchingBranches, validateConfigShape } from './validate';

describe('compileRegex', () => {
  test('compiles valid patterns', () => {
    expect(compileRegex('release/.*')).toBeInstanceOf(RegExp);
  });

  test('returns null for invalid patterns', () => {
    expect(compileRegex('release/(')).toBeNull();
  });
});

describe('matchingBranches', () => {
  test('filters branch names', () => {
    const regex = compileRegex('^release/v2')!;
    expect(matchingBranches(['release/v2.1', 'release/v3', 'main'], regex)).toEqual(['release/v2.1']);
  });
});

describe('validateConfigShape', () => {
  test('passes for a reasonable config', () => {
    expect(validateConfigShape({ repos: ['targoninc/a'], branchRegex: 'release/.*' })).toEqual([]);
  });

  test('explains missing repositories and invalid regexes', () => {
    const errors = validateConfigShape({ repos: [], branchRegex: 'release/(' });
    expect(errors).toHaveLength(2);
  });
});

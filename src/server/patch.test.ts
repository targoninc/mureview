import { describe, expect, test } from 'bun:test';
import { processFile } from '@pierre/diffs';
import { addedFilePatch, countLines, withPatchHeader } from './patch';

describe('addedFilePatch', () => {
  test('produces a patch the diff renderer can parse', () => {
    const patch = addedFilePatch('src/hello.ts', 'export const hello = 1;\nexport const world = 2;\n');
    const parsed = processFile(patch, { cacheKey: 'test' });
    expect(parsed).toBeDefined();
    expect(parsed!.name).toBe('src/hello.ts');
    expect(parsed!.type).toBe('new');
    expect(parsed!.additionLines.map((line) => line.trim())).toEqual(['export const hello = 1;', 'export const world = 2;']);
  });
});

describe('withPatchHeader', () => {
  test('wraps GitHub hunk-only patches so the renderer sees the file name', () => {
    const hunk = '@@ -1,3 +1,4 @@\n context\n-removed\n+added\n+added too\n';
    const patch = withPatchHeader({ path: 'src/app.ts', type: 'modified', additions: 2, deletions: 1, patch: hunk });
    const parsed = processFile(patch, { cacheKey: 'test' });
    expect(parsed).toBeDefined();
    expect(parsed!.name).toBe('src/app.ts');
  });

  test('keeps rename information', () => {
    const hunk = '@@ -1 +1 @@\n-old\n+new\n';
    const patch = withPatchHeader({ path: 'src/new.ts', prevPath: 'src/old.ts', type: 'renamed', additions: 1, deletions: 1, patch: hunk });
    const parsed = processFile(patch, { cacheKey: 'test' });
    expect(parsed).toBeDefined();
    expect(parsed!.name).toBe('src/new.ts');
    expect(parsed!.prevName).toBe('src/old.ts');
  });
});

describe('countLines', () => {
  test('ignores a trailing newline', () => {
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('')).toBe(0);
  });
});

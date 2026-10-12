import { describe, expect, test } from 'bun:test';
import { processFile } from '@pierre/diffs';
import { addedFilePatch, countLines } from './patch';

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

describe('countLines', () => {
  test('ignores a trailing newline', () => {
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('')).toBe(0);
  });
});

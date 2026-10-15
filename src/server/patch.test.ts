import { describe, expect, test } from 'bun:test';
import { processFile } from '@pierre/diffs';
import { addedFilePatch, countLines, deletedFilePatch, modifiedFilePatch, withPatchHeader } from './patch';

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

describe('deletedFilePatch', () => {
  test('parses as a deletion', () => {
    const patch = deletedFilePatch('src/old.ts', 'a\nb\n');
    const parsed = processFile(patch, { cacheKey: 'test' });
    expect(parsed).toBeDefined();
    expect(parsed!.name).toBe('src/old.ts');
    expect(parsed!.type).toBe('deleted');
  });
});

describe('modifiedFilePatch', () => {
  test('generates hunks from old and new contents', () => {
    const patch = modifiedFilePatch({ path: 'src/app.ts', type: 'modified' }, 'one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n');
    const parsed = processFile(patch, { cacheKey: 'test' });
    expect(parsed).toBeDefined();
    expect(parsed!.name).toBe('src/app.ts');
    expect(parsed!.type).toBe('change');
  });
});

describe('withPatchHeader', () => {
  test('wraps GitHub hunk-only patches so the renderer sees the file name', () => {
    const hunk = '@@ -1,3 +1,4 @@\n context\n-removed\n+added\n+added too\n';
    const patch = withPatchHeader({ path: 'src/app.ts', type: 'modified', patch: hunk });
    const parsed = processFile(patch, { cacheKey: 'test' });
    expect(parsed).toBeDefined();
    expect(parsed!.name).toBe('src/app.ts');
  });

  test('keeps rename information', () => {
    const hunk = '@@ -1 +1 @@\n-old\n+new\n';
    const patch = withPatchHeader({ path: 'src/new.ts', prevPath: 'src/old.ts', type: 'renamed', patch: hunk });
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

test('hunks keep their declared line counts when files lack trailing newlines', () => {
  const patch = modifiedFilePatch({ path: 'x.txt', type: 'modified' }, 'a\nb\nc\nd', 'a\nB\nc\nd\ne');
  const lines = patch.split('\n');
  const header = lines.find((line) => line.startsWith('@@'));
  const match = header?.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
  expect(match).not.toBeNull();
  const oldLines = Number(match![2]);
  const newLines = Number(match![4]);
  const body = lines.slice(lines.indexOf(header!) + 1).filter((line) => line !== '');
  expect(body.filter((line) => line.startsWith('-') || line.startsWith(' ')).length).toBe(oldLines);
  expect(body.filter((line) => line.startsWith('+') || line.startsWith(' ')).length).toBe(newLines);
  expect(patch).not.toContain('\\ No newline');
  expect(processFile(patch)).toBeTruthy();

  const both = modifiedFilePatch({ path: 'x.txt', type: 'modified' }, 'a\nb\nc\nd', 'a\nB\nc\nd');
  expect(both).not.toContain('\\ No newline');
  expect(processFile(both)).toBeTruthy();
});

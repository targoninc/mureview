import { describe, expect, test } from 'bun:test';
import { orderByTree } from './fileTree';

const entry = (treePath: string) => ({ segments: treePath.split('/'), itemId: treePath });

describe('orderByTree', () => {
  test('matches the tree order: directories first, then alphabetical', () => {
    const entries = [entry('gh/o/r/src/z.ts'), entry('gh/o/r/README.md'), entry('gh/o/r/src/a/x.ts'), entry('gh/o/r/src/b.ts')];
    expect(orderByTree(entries).map((item) => item.itemId)).toEqual([
      'gh/o/r/src/a/x.ts',
      'gh/o/r/src/b.ts',
      'gh/o/r/src/z.ts',
      'gh/o/r/README.md',
    ]);
  });

  test('orders multiple forges alphabetically', () => {
    const entries = [entry('git.example.org/o/zeta/a.ts'), entry('github.com/o/alpha/b.ts')];
    expect(orderByTree(entries).map((item) => item.itemId)).toEqual(['git.example.org/o/zeta/a.ts', 'github.com/o/alpha/b.ts']);
  });

  test('keeps every entry exactly once', () => {
    const entries = [entry('gh/o/r/a/b.ts'), entry('gh/o/r/a/c.ts'), entry('gh/o/r/d/e/f.ts')];
    expect(orderByTree(entries)).toHaveLength(3);
  });
});

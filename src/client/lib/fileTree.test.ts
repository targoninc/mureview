import { describe, expect, test } from 'bun:test';
import { orderByTree } from './fileTree';

const entry = (repo: string, path: string) => ({ repo, path, itemId: `${repo}:${path}` });

describe('orderByTree', () => {
  test('matches the tree order: directories first, then alphabetical', () => {
    const entries = [entry('o/r', 'src/z.ts'), entry('o/r', 'README.md'), entry('o/r', 'src/a/x.ts'), entry('o/r', 'src/b.ts')];
    expect(orderByTree(entries).map((item) => item.path)).toEqual(['src/a/x.ts', 'src/b.ts', 'src/z.ts', 'README.md']);
  });

  test('orders multiple repositories alphabetically', () => {
    const entries = [entry('o/zeta', 'a.ts'), entry('o/alpha', 'b.ts')];
    expect(orderByTree(entries).map((item) => item.repo)).toEqual(['o/alpha', 'o/zeta']);
  });

  test('keeps every entry exactly once', () => {
    const entries = [entry('o/r', 'a/b.ts'), entry('o/r', 'a/c.ts'), entry('o/r', 'd/e/f.ts')];
    expect(orderByTree(entries)).toHaveLength(3);
  });
});

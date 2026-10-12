import { describe, expect, test } from 'bun:test';
import { hasConflict } from './conflicts';

const base = ['one', 'two', 'three', 'four', 'five', 'six'].join('\n');
const withLine = (index: number, value: string) => {
  const lines = base.split('\n');
  lines[index] = value;
  return lines.join('\n');
};

describe('hasConflict', () => {
  test('detects edits to the same lines', () => {
    expect(hasConflict(base, withLine(2, 'OURS'), withLine(2, 'THEIRS'))).toBe(true);
  });

  test('accepts edits to different lines', () => {
    expect(hasConflict(base, withLine(1, 'OURS'), withLine(4, 'THEIRS'))).toBe(false);
  });

  test('accepts identical edits', () => {
    expect(hasConflict(base, withLine(2, 'SAME'), withLine(2, 'SAME'))).toBe(false);
  });

  test('detects opposing insertions at the same spot', () => {
    expect(hasConflict(base, 'one\nOURS\ntwo', 'one\nTHEIRS\ntwo')).toBe(true);
  });

  test('accepts insertions at different spots', () => {
    const ours = base.replace('two', 'OURS\ntwo');
    const theirs = base.replace('four', 'THEIRS\nfour');
    expect(hasConflict(base, ours, theirs)).toBe(false);
  });
});

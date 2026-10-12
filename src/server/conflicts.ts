import { structuredPatch } from 'diff';

interface Hunk {
  oldStart: number;
  oldLines: number;
  newLines: number;
  lines: string[];
}

/**
 * Approximates git's conflict detection for a three-way merge: two branches
 * conflict when they changed overlapping regions of the same file since their
 * common ancestor, unless both applied the exact same change.
 */
export function hasConflict(base: string, ours: string, theirs: string): boolean {
  const oursHunks = structuredPatch('base', 'ours', base, ours, '', '', { context: 0 }).hunks;
  const theirsHunks = structuredPatch('base', 'theirs', base, theirs, '', '', { context: 0 }).hunks;

  for (const a of oursHunks) {
    for (const b of theirsHunks) {
      if (!overlap(a, b)) continue;
      if (!sameChange(a, b)) return true;
    }
  }
  return false;
}

function overlap(a: Hunk, b: Hunk): boolean {
  const aEnd = a.oldStart + Math.max(a.oldLines - 1, 0);
  const bEnd = b.oldStart + Math.max(b.oldLines - 1, 0);
  return a.oldStart <= bEnd && b.oldStart <= aEnd;
}

function sameChange(a: Hunk, b: Hunk): boolean {
  return a.oldStart === b.oldStart && a.oldLines === b.oldLines && a.lines.join('\n') === b.lines.join('\n');
}

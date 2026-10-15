import { structuredPatch } from 'diff';
import type { FileDiff } from '../shared/types';

export type PatchTarget = Pick<FileDiff, 'path' | 'prevPath' | 'type'> & { patch?: string | null };

export function patchHeader(file: PatchTarget): string {
  const oldPath = (file.type === 'renamed' || file.type === 'copied') && file.prevPath ? file.prevPath : file.path;
  const lines = [`diff --git a/${oldPath} b/${file.path}`];
  if (file.type === 'added') lines.push('new file mode 100644');
  else if (file.type === 'deleted') lines.push('deleted file mode 100644');
  else if (file.type === 'renamed' && file.prevPath) {
    lines.push('similarity index 100%', `rename from ${file.prevPath}`, `rename to ${file.path}`);
  }
  lines.push(`--- ${file.type === 'added' ? '/dev/null' : `a/${oldPath}`}`);
  lines.push(`+++ ${file.type === 'deleted' ? '/dev/null' : `b/${file.path}`}`);
  return `${lines.join('\n')}\n`;
}

export function withPatchHeader(file: PatchTarget): string {
  return patchHeader(file) + (file.patch ?? '');
}

export function addedFilePatch(path: string, content: string): string {
  const lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((line) => `+${line}`).join('\n');
  const hunk = `@@ -0,0 +1,${lines.length} @@\n${body}\n`;
  return patchHeader({ path, type: 'added' }) + hunk;
}

export function patchStats(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

export function countLines(content: string): number {
  const lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function hunkText(oldContent: string, newContent: string): string {
  const { hunks } = structuredPatch('a', 'b', oldContent, newContent, '', '', { context: 3 });
  return hunks
    .map(
      (hunk) =>
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines
          // The "no newline" markers do not count towards the hunk header, so
          // they must not appear in the body either.
          .filter((line) => !line.startsWith('\\ No newline'))
          .join('\n')}`,
    )
    .join('\n')
    .concat(hunks.length ? '\n' : '');
}

export function modifiedFilePatch(file: PatchTarget, oldContent: string, newContent: string): string {
  return patchHeader(file) + hunkText(oldContent, newContent);
}

export function deletedFilePatch(path: string, content: string): string {
  const lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((line) => `-${line}`).join('\n');
  return `${patchHeader({ path, type: 'deleted' })}@@ -1,${lines.length} +0,0 @@\n${body}\n`;
}

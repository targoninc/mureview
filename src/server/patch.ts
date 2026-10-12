import type { FileDiff } from '../shared/types';

export type PatchTarget = Pick<FileDiff, 'path' | 'prevPath' | 'type'>;

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

export function withPatchHeader(file: FileDiff): string {
  return patchHeader(file) + (file.patch ?? '');
}

export function addedFilePatch(path: string, content: string): string {
  const lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((line) => `+${line}`).join('\n');
  const hunk = `@@ -0,0 +1,${lines.length} @@\n${body}\n`;
  return patchHeader({ path, type: 'added' }) + hunk;
}

export function countLines(content: string): number {
  const lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

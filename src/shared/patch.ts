export function repairHunkCounts(patch: string): string {
  const lines = patch.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(lines[index]);
    if (!match) continue;
    let oldLines = 0;
    let newLines = 0;
    let end = index + 1;
    for (; end < lines.length; end++) {
      const line = lines[end];
      if (line.startsWith('@@ ') || line.startsWith('diff --git ')) break;
      if (line.startsWith('\\')) continue;
      if (line.startsWith('+')) newLines++;
      else if (line.startsWith('-')) oldLines++;
      else if (line.startsWith(' ')) {
        oldLines++;
        newLines++;
      }
    }
    lines[index] = `@@ -${match[1]},${oldLines} +${match[2]},${newLines} @@${match[3]}`;
    index = end - 1;
  }
  return lines.join('\n');
}

export interface SnippetLine {
  number: number;
  text: string;
  kind: 'context' | 'addition' | 'deletion';
  target: boolean;
}

export interface CodeSnippet {
  lines: SnippetLine[];
}

/**
 * The commented line and its neighbours from a unified patch, the way Azure
 * DevOps shows the code a comment was written on.
 */
export function codeSnippet(
  patch: string,
  line: number,
  side: 'additions' | 'deletions',
  context = 1,
): CodeSnippet | null {
  const all: SnippetLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match) {
        oldNumber = Number(match[1]);
        newNumber = Number(match[2]);
      }
      continue;
    }
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
    if (raw === '') continue;

    const kind = raw.startsWith('+') ? 'addition' : raw.startsWith('-') ? 'deletion' : 'context';
    const number = kind === 'deletion' ? oldNumber : newNumber;
    const isTarget = (side === 'additions' ? kind !== 'deletion' : kind !== 'addition') && number === line;
    all.push({ number, text: raw.slice(1), kind, target: isTarget });

    if (kind === 'addition') newNumber += 1;
    else if (kind === 'deletion') oldNumber += 1;
    else {
      oldNumber += 1;
      newNumber += 1;
    }
  }

  const targetIndex = all.findIndex((entry) => entry.target);
  if (targetIndex === -1) return null;
  const start = Math.max(0, targetIndex - context);
  return { lines: all.slice(start, targetIndex + context + 1) };
}

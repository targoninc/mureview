import type { RepoStatus } from '../../shared/types';
import { findItemRefs, findMentions } from './refs';

/** Custom link schemes the renderer turns back into chips. */
export const REF_SCHEME = 'mureview-ref:';
export const MENTION_SCHEME = 'mureview-mention:';

/**
 * Rewrites the forge's own syntax — references like `#123`/`!123` and Azure
 * DevOps `@<identity-id>` mentions — into markdown links that the renderer
 * turns into chips. Code spans and fenced blocks are left alone.
 */
export function preprocessBody(body: string, status: RepoStatus | undefined): string {
  if (!status) return body;
  const lines = body.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const tokens = [...findItemRefs(line, status), ...findMentions(line, status)].sort((a, b) => a.start - b.start);
    if (!tokens.length) {
      out.push(line);
      continue;
    }
    let text = '';
    let cursor = 0;
    for (const token of tokens) {
      text += line.slice(cursor, token.start);
      text +=
        'type' in token
          ? `[${token.text}](${REF_SCHEME}${token.type}:${token.id})`
          : `[${token.text}](${MENTION_SCHEME}${token.id})`;
      cursor = token.end;
    }
    text += line.slice(cursor);
    out.push(text);
  }
  return out.join('\n');
}

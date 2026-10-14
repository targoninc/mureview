import type { ReactNode } from 'react';

/**
 * A small, safe subset of the markdown comments use: inline code, bold,
 * italic, strikethrough, links and bare URLs, with single newlines as breaks.
 * Everything else stays literal text; no HTML is ever interpreted.
 * Underscore emphasis is deliberately left out so snake_case stays readable.
 */
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+)/g;

function textNodes(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) nodes.push(<br key={`${keyPrefix}-br-${index}`} />);
    if (line) nodes.push(line);
  });
  return nodes;
}

/** Renders the inline markdown of one run of comment text. */
export function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  for (let match = INLINE.exec(text); match; match = INLINE.exec(text)) {
    if (match.index > cursor) {
      nodes.push(...textNodes(text.slice(cursor, match.index), `${keyPrefix}-t${index}`));
    }
    const [full, code, bold, italic, strike, link, linkUrl, autolink] = match;
    const key = `${keyPrefix}-m${index++}`;
    if (code) nodes.push(<code key={key} className="comment-inline-code">{code.slice(1, -1)}</code>);
    else if (bold) nodes.push(<strong key={key}>{bold.slice(2, -2)}</strong>);
    else if (italic) nodes.push(<em key={key}>{italic.slice(1, -1)}</em>);
    else if (strike) nodes.push(<del key={key}>{strike.slice(2, -2)}</del>);
    else if (link && linkUrl) {
      nodes.push(
        <a key={key} className="comment-link" href={linkUrl} target="_blank" rel="noreferrer">
          {link.slice(1, link.indexOf(']'))}
        </a>,
      );
    } else if (autolink) {
      nodes.push(
        <a key={key} className="comment-link" href={autolink} target="_blank" rel="noreferrer">
          {autolink}
        </a>,
      );
    }
    cursor = match.index + full.length;
  }
  if (cursor < text.length) nodes.push(...textNodes(text.slice(cursor), `${keyPrefix}-t${index}`));
  return nodes;
}

export type BodySegment = { kind: 'text'; text: string } | { kind: 'code'; code: string; language: string };

/** Splits a comment body into fenced code blocks and the text around them. */
export function splitCodeFences(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let text: string[] = [];
  let code: string[] | null = null;
  let language = '';

  const flushText = () => {
    if (!text.length) return;
    segments.push({ kind: 'text', text: text.join('\n') });
    text = [];
  };
  const flushCode = () => {
    if (code === null) return;
    segments.push({ kind: 'code', code: code.join('\n'), language });
    code = null;
    language = '';
  };

  for (const line of body.split('\n')) {
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      if (code === null) {
        flushText();
        code = [];
        language = fence[1] ?? '';
      } else {
        flushCode();
      }
      continue;
    }
    if (code === null) text.push(line);
    else code.push(line);
  }
  flushCode();
  flushText();
  return segments;
}

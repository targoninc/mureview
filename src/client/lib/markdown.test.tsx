import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderInlineMarkdown, splitCodeFences } from './markdown';

const html = (text: string) => renderToStaticMarkup(<>{renderInlineMarkdown(text, 'k')}</>);

test('renders the markdown comments use', () => {
  expect(html('**bold** and *italic* and ~~gone~~')).toBe('<strong>bold</strong> and <em>italic</em> and <del>gone</del>');
  expect(html('use `npm run build` here')).toBe('use <code class="comment-inline-code">npm run build</code> here');
  expect(html('see [the docs](https://example.com/x)')).toBe('see <a class="comment-link" href="https://example.com/x" target="_blank" rel="noreferrer">the docs</a>');
  expect(html('at https://example.com/y now')).toBe('at <a class="comment-link" href="https://example.com/y" target="_blank" rel="noreferrer">https://example.com/y</a> now');
  expect(html('first\nsecond')).toBe('first<br/>second');
});

test('leaves snake_case and unsafe urls alone', () => {
  expect(html('call find_item_refs()')).toBe('call find_item_refs()');
  expect(html('javascript:alert(1)')).toBe('javascript:alert(1)');
  expect(html('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
});

test('splits fenced code from the text around it', () => {
  const segments = splitCodeFences('before\n```ts\nconst x = 1;\n```\nafter');
  expect(segments).toEqual([
    { kind: 'text', text: 'before' },
    { kind: 'code', code: 'const x = 1;', language: 'ts' },
    { kind: 'text', text: 'after' },
  ]);
  expect(splitCodeFences('no code here')).toEqual([{ kind: 'text', text: 'no code here' }]);
});

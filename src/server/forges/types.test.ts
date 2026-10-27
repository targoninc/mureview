import { afterAll, expect, test } from 'bun:test';
import { fetchImage } from './types';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/image.png') return new Response(png, { headers: { 'content-type': 'image/png' } });
    if (url.pathname === '/redirect-same') {
      return new Response(null, { status: 302, headers: { location: '/image.png' } });
    }
    if (url.pathname === '/redirect-cross') {
      return new Response(null, { status: 302, headers: { location: `http://localhost:${url.port}/image.png` } });
    }
    if (url.pathname === '/svg') return new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } });
    if (url.pathname === '/html') return new Response('<h1>no</h1>', { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/big') return new Response(Buffer.alloc(2_000_001), { headers: { 'content-type': 'image/png' } });
    return new Response('not found', { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

test('fetchImage follows same-origin redirects and rejects cross-origin ones', async () => {
  expect((await fetchImage(`${base}/image.png`))?.body).toEqual(png);
  expect((await fetchImage(`${base}/redirect-same`))?.body).toEqual(png);
  expect(await fetchImage(`${base}/redirect-cross`)).toBeNull();
});

test('fetchImage accepts images only and caps the body size', async () => {
  expect(await fetchImage(`${base}/svg`)).toBeNull();
  expect(await fetchImage(`${base}/html`)).toBeNull();
  expect(await fetchImage(`${base}/big`)).toBeNull();
});

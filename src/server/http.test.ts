import { expect, test } from 'bun:test';
import { clearCookie, json, parseCookies, readJson } from './http';

test('parseCookies tolerates malformed escapes', () => {
  const cookies = parseCookies('bad=%E0%A4%A; good=value');
  expect(cookies.bad).toBe('%E0%A4%A');
  expect(cookies.good).toBe('value');
});

test('readJson rejects oversized bodies', async () => {
  const request = new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `"${'x'.repeat(1_000_001)}"`,
  });
  await expect(readJson(request)).rejects.toMatchObject({ status: 413 });
});

test('API responses are not cached and secure cookies clear with Secure', () => {
  expect(json({ ok: true }).headers.get('cache-control')).toBe('no-store');
  expect(clearCookie('sid', '/', true)).toContain('Secure');
});

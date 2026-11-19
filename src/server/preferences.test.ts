import { describe, expect, test } from 'bun:test';
import { publicUser } from './auth/session';
import { type UserRow, db } from './db';
import { updatePreferences } from './preferences';
import type { Ctx } from './router';

function addUser(name: string): number {
  const inserted = db.run('INSERT INTO users (name) VALUES (?)', [name]);
  return Number(inserted.lastInsertRowid);
}

function userRow(id: number): UserRow {
  return db.query<UserRow, [number]>('SELECT * FROM users WHERE id = ?').get(id)!;
}

function userCtx(userId: number, body: unknown): Ctx {
  const url = new URL('http://localhost/api/me/preferences');
  return {
    req: new Request(url, { method: 'PUT', body: JSON.stringify(body) }),
    url,
    path: '/api/me/preferences',
    params: {},
    user: userRow(userId),
  };
}

describe('updatePreferences', () => {
  test('boolean preferences default to off', () => {
    const id = addUser('pref-default');
    expect(publicUser(userRow(id))).toMatchObject({ autoMarkViewed: false, hideViewedFiles: false });
  });

  test('boolean preferences are saved and read back', async () => {
    const id = addUser('pref-toggle');
    await updatePreferences(userCtx(id, { autoMarkViewed: true, hideViewedFiles: true }));
    expect(publicUser(userRow(id))).toMatchObject({ autoMarkViewed: true, hideViewedFiles: true });

    await updatePreferences(userCtx(id, { autoMarkViewed: false }));
    expect(publicUser(userRow(id))).toMatchObject({ autoMarkViewed: false, hideViewedFiles: true });
  });

  test('rejects non-boolean preference values', async () => {
    const id = addUser('pref-invalid');
    await expect(updatePreferences(userCtx(id, { hideViewedFiles: 'yes' }))).rejects.toThrow('"hideViewedFiles" must be a boolean.');
    expect(publicUser(userRow(id)).hideViewedFiles).toBe(false);
  });

  test('monospace fonts still save through the same route', async () => {
    const id = addUser('pref-font');
    await updatePreferences(userCtx(id, { monoFont: 'fira-code' }));
    expect(userRow(id).mono_font).toBe('fira-code');
    await expect(updatePreferences(userCtx(id, { monoFont: 'comic-sans' }))).rejects.toThrow('Unknown monospace font.');
  });

  test('the diff font size defaults to 15 and only accepts the offered sizes', async () => {
    const id = addUser('pref-size');
    expect(publicUser(userRow(id)).diffFontSize).toBe(15);

    await updatePreferences(userCtx(id, { diffFontSize: 18 }));
    expect(publicUser(userRow(id)).diffFontSize).toBe(18);

    await expect(updatePreferences(userCtx(id, { diffFontSize: 99 }))).rejects.toThrow('diff font size');
    await expect(updatePreferences(userCtx(id, { diffFontSize: '18' }))).rejects.toThrow('diff font size');
    expect(publicUser(userRow(id)).diffFontSize).toBe(18);
  });
});

test('keybind overrides save, read back, and reject invalid or duplicate shortcuts', async () => {
  const id = addUser('pref-keybinds');
  await updatePreferences(userCtx(id, { keybinds: { 'previous-file': 'Ctrl+Alt+P' } }));
  expect(publicUser(userRow(id)).keybinds).toEqual({ 'previous-file': 'Ctrl+Alt+P' });

  await expect(updatePreferences(userCtx(id, { keybinds: { 'previous-file': 'not a shortcut' } }))).rejects.toThrow(
    'valid keyboard combination',
  );
  await expect(
    updatePreferences(userCtx(id, { keybinds: { 'next-file': 'Mod+Shift+ArrowUp' } })),
  ).rejects.toThrow('assigned to more than one action');

  await updatePreferences(userCtx(id, { keybinds: {} }));
  expect(publicUser(userRow(id)).keybinds).toEqual({});
});

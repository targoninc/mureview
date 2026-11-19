import { db } from './db';
import { requireUser } from './auth/session';
import { HttpError, json } from './http';
import { readJson } from './http';
import type { Ctx } from './router';
import { ALL_MONO_FONT_IDS, DIFF_FONT_SIZES } from '../shared/fonts';
import { KEYBINDS, isValidKeybindCombo, keybindFor } from '../shared/keybinds';

/** User preference columns that store a boolean. */
const booleanPreferences = { autoMarkViewed: 'auto_mark_viewed', hideViewedFiles: 'hide_viewed_files' } as const;

export async function updatePreferences(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const body = await readJson<{ monoFont?: unknown; diffFontSize?: unknown; keybinds?: unknown } & Record<string, unknown>>(
    ctx.req,
  );

  if (body.monoFont !== undefined) {
    const id = body.monoFont;
    if (typeof id !== 'string' || !ALL_MONO_FONT_IDS.includes(id)) throw new HttpError(400, 'Unknown monospace font.');
    db.run('UPDATE users SET mono_font = ? WHERE id = ?', [id, user.id]);
  }

  if (body.diffFontSize !== undefined) {
    const size = body.diffFontSize;
    if (typeof size !== 'number' || !Number.isInteger(size) || !DIFF_FONT_SIZES.includes(size)) {
      throw new HttpError(400, `The diff font size must be one of ${DIFF_FONT_SIZES.join(', ')} pixels.`);
    }
    db.run('UPDATE users SET diff_font_size = ? WHERE id = ?', [size, user.id]);
  }

  for (const [key, column] of Object.entries(booleanPreferences)) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new HttpError(400, `"${key}" must be a boolean.`);
    db.run(`UPDATE users SET ${column} = ? WHERE id = ?`, [value ? 1 : 0, user.id]);
  }

  if (body.keybinds !== undefined) {
    const value = body.keybinds;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new HttpError(400, '"keybinds" must be an object.');
    }
    const next: Record<string, string> = {};
    for (const [id, combo] of Object.entries(value)) {
      if (!KEYBINDS.some((keybind) => keybind.id === id)) throw new HttpError(400, `Unknown keybind "${id}".`);
      if (typeof combo !== 'string' || !isValidKeybindCombo(combo)) {
        throw new HttpError(400, `"${id}" must be a valid keyboard combination.`);
      }
      next[id] = combo;
    }
    const used = new Map<string, string>();
    for (const keybind of KEYBINDS) {
      const combo = keybindFor(next, keybind.id);
      const existing = used.get(combo);
      if (existing && existing !== keybind.id) {
        throw new HttpError(400, `"${combo}" is assigned to more than one action.`);
      }
      used.set(combo, keybind.id);
    }
    db.run('UPDATE users SET keybinds = ? WHERE id = ?', [JSON.stringify(next), user.id]);
  }

  return json({ ok: true });
}

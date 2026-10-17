import { db } from './db';
import { requireUser } from './auth/session';
import { HttpError, json } from './http';
import { readJson } from './http';
import type { Ctx } from './router';
import { ALL_MONO_FONT_IDS } from '../shared/fonts';

/** User preference columns that store a boolean. */
const booleanPreferences = { autoMarkViewed: 'auto_mark_viewed', hideViewedFiles: 'hide_viewed_files' } as const;

export async function updatePreferences(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const body = await readJson<{ monoFont?: unknown } & Record<string, unknown>>(ctx.req);

  if (body.monoFont !== undefined) {
    const id = body.monoFont;
    if (typeof id !== 'string' || !ALL_MONO_FONT_IDS.includes(id)) throw new HttpError(400, 'Unknown monospace font.');
    db.run('UPDATE users SET mono_font = ? WHERE id = ?', [id, user.id]);
  }

  for (const [key, column] of Object.entries(booleanPreferences)) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new HttpError(400, `"${key}" must be a boolean.`);
    db.run(`UPDATE users SET ${column} = ? WHERE id = ?`, [value ? 1 : 0, user.id]);
  }

  return json({ ok: true });
}

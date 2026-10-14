import { db } from './db';
import { requireUser } from './auth/session';
import { HttpError, json } from './http';
import { readJson } from './http';
import type { Ctx } from './router';
import { ALL_MONO_FONT_IDS } from '../shared/fonts';

export async function updatePreferences(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const body = await readJson<{ monoFont?: unknown }>(ctx.req);

  if (body.monoFont !== undefined) {
    const id = body.monoFont;
    if (typeof id !== 'string' || !ALL_MONO_FONT_IDS.includes(id)) throw new HttpError(400, 'Unknown monospace font.');
    db.run('UPDATE users SET mono_font = ? WHERE id = ?', [id, user.id]);
  }

  return json({ ok: true });
}

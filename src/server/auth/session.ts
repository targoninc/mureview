import type { User } from '../../shared/types';
import { constants, config } from '../config';
import { randomToken } from '../crypto';
import { type UserRow, db } from '../db';
import { HttpError, clearCookie, parseCookies, setCookie } from '../http';
import type { Ctx } from '../router';

export function publicUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    avatarUrl: row.avatar_url,
    monoFont: row.mono_font ?? null,
    diffFontSize: row.diff_font_size,
    autoMarkViewed: row.auto_mark_viewed === 1,
    hideViewedFiles: row.hide_viewed_files === 1,
  };
}

export function getSessionUser(req: Request): UserRow | null {
  const token = parseCookies(req.headers.get('cookie'))[constants.sessionCookie];
  if (!token) return null;
  return (
    db
      .query<UserRow, [string]>(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')`)
      .get(token) ?? null
  );
}

export function requireUser(ctx: Ctx): UserRow {
  if (!ctx.user) throw new HttpError(401, 'Sign in to continue.');
  return ctx.user;
}

export const cookiePath = () => config.basePath || '/';
export const isSecure = () => config.baseUrl.startsWith('https');

export function startSession(userId: number): string {
  const token = randomToken();
  db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`, [
    token,
    userId,
    `+${constants.sessionDays} days`,
  ]);
  return setCookie(constants.sessionCookie, token, {
    path: cookiePath(),
    httpOnly: true,
    secure: isSecure(),
    maxAge: constants.sessionDays * 86400,
  });
}

export function endSession(req: Request): string {
  const token = parseCookies(req.headers.get('cookie'))[constants.sessionCookie];
  if (token) db.run('DELETE FROM sessions WHERE token = ?', [token]);
  return clearCookie(constants.sessionCookie, cookiePath());
}

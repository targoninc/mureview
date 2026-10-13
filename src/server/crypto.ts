import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config';

function rootSecret(): string {
  if (config.sessionSecret) return config.sessionSecret;
  // Imported lazily so modules that only need crypto don't open the database.
  const { getSetting, setSetting } = require('./db') as typeof import('./db');
  let stored = getSetting('secret');
  if (!stored) {
    stored = randomBytes(32).toString('hex');
    setSetting('secret', stored);
  }
  return stored;
}

let cachedKey: Buffer | null = null;

function cipherKey(): Buffer {
  if (!cachedKey) cachedKey = createHash('sha256').update(rootSecret()).digest();
  return cachedKey;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cipherKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', cipherKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

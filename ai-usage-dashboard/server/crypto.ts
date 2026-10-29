// Server-side secret storage with AES-256-GCM encryption at rest.
// The master key lives ONLY on the server (env MASTER_KEY or a local keyfile).
// Plaintext API keys are never sent to the browser — only masked hints.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let masterKey: Buffer | null = null;

function getMasterKey(dataDir: string): Buffer {
  if (masterKey) return masterKey;
  const envKey = process.env.MASTER_KEY;
  if (envKey && envKey.length >= 16) {
    masterKey = crypto.createHash('sha256').update(envKey, 'utf8').digest();
    return masterKey;
  }
  // Generate and persist a keyfile (0600) so secrets survive restarts.
  const keyfile = path.join(dataDir, '.master.key');
  if (fs.existsSync(keyfile)) {
    masterKey = Buffer.from(fs.readFileSync(keyfile, 'utf8').trim(), 'hex');
  } else {
    masterKey = crypto.randomBytes(32);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyfile, masterKey.toString('hex'), { mode: 0o600 });
  }
  return masterKey;
}

export function encrypt(plain: string, dataDir: string): string {
  const key = getMasterKey(dataDir);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(stored: string, dataDir: string): string {
  const key = getMasterKey(dataDir);
  const [version, ivHex, tagHex, dataHex] = stored.split(':');
  if (version !== 'v1' || !ivHex || !tagHex || !dataHex) {
    throw new Error('Malformed encrypted secret');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

/** Mask an API key for safe display, e.g. "sk-or-v1…9f3a" */
export function maskKey(key: string): string {
  if (!key) return '';
  const tail = key.slice(-4);
  const head = key.length > 12 ? key.slice(0, Math.min(10, key.indexOf('-') > 0 ? key.indexOf('-') + 7 : 10)) : key.slice(0, 4);
  return `${head}…${tail}`;
}

/** SHA-256 hex of a session token — we store hashes, not raw tokens. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, saltHex, keyHex] = stored.split('$');
  if (!saltHex || !keyHex) return false;
  const key = await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return expected.length === key.length && timingSafeEqual(expected, key);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function token(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function otpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function shortId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export function hmacSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function cipherKey(): Buffer {
  return createHash('sha256').update(config.secretKey).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', cipherKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(stored: string): string {
  const [iv, tag, data] = stored.split('.').map((p) => Buffer.from(p, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', cipherKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

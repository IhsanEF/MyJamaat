import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDatabase } from './database.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
const configuredOrigin = () => process.env.PUBLIC_ORIGIN ?? process.env.RENDER_EXTERNAL_URL;
export const origin = () => new URL(configuredOrigin()).origin;
export function validateConfiguration() {
  const url = new URL(configuredOrigin());
  if (url.href !== `${url.origin}/` || url.username || url.password) throw new Error('PUBLIC_ORIGIN must be an origin without a path.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('PUBLIC_ORIGIN requires HTTPS outside localhost.');
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new Error('Google OAuth client configuration is required.');
  if (!allowedEmails().size) throw new Error('ALLOWED_SIGN_IN_EMAILS is required for the pilot.');
  if (process.env.TURSO_DATABASE_URL) {
    const databaseUrl = new URL(process.env.TURSO_DATABASE_URL);
    if (!['libsql:', 'https:', ...(process.env.RENDER ? [] : ['file:'])].includes(databaseUrl.protocol) || databaseUrl.username || databaseUrl.password || databaseUrl.search || databaseUrl.hash) throw new Error('Invalid Turso database URL.');
    if (databaseUrl.protocol !== 'file:' && !process.env.TURSO_AUTH_TOKEN) throw new Error('TURSO_AUTH_TOKEN is required.');
  } else if (process.env.RENDER && !process.env.SQLITE_PATH?.startsWith('/var/data/')) throw new Error('Render requires remote Turso storage or an attached /var/data disk.');
}
export function allowedEmails() {
  return new Set((process.env.ALLOWED_SIGN_IN_EMAILS ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean));
}
export function cookieName(purpose) { return `${origin().startsWith('https:') ? '__Host-' : ''}mj_${purpose}`; }
export function readCookie(header, name) {
  const entries = (header ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  return entries.length === 1 ? entries[0].slice(name.length + 1) : null;
}
export function cookie(purpose, value, maxAge) {
  return `${cookieName(purpose)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin().startsWith('https:') ? '; Secure' : ''}`;
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length > 2048 || b.length > 2048) return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
export function safeReturnTo(value = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
  const url = new URL(value, 'https://app.local');
  if (url.origin !== 'https://app.local' || /^\/(?:signin|signout|auth|callback|signin-with-chatgpt|signout-with-chatgpt)(?:\/|$)/.test(url.pathname)) return '/';
  return `${url.pathname}${url.search}`;
}
export async function verifiedUser(header) {
  const token = readCookie(header, cookieName('session'));
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const session = await getDatabase().prepare('SELECT * FROM render_sessions WHERE token_hash=? AND expires_at>?').bind(sha256(token), Date.now()).first();
  if (!session || !allowedEmails().has(session.email.toLowerCase())) return null;
  return { userId: session.user_id, email: session.email, fullName: session.full_name, displayName: session.full_name || session.email };
}
export async function createSession(user) {
  const token = randomToken();
  const db = getDatabase();
  await db.batch([
    db.prepare('DELETE FROM render_sessions WHERE expires_at<=?').bind(Date.now()),
    db.prepare('INSERT INTO render_sessions VALUES (?,?,?,?,?)').bind(sha256(token), user.userId, user.email, user.fullName ?? null, Date.now() + 7*86400000),
  ]);
  return token;
}
export async function revokeSession(header) {
  const token = readCookie(header, cookieName('session'));
  if (token) await getDatabase().prepare('DELETE FROM render_sessions WHERE token_hash=?').bind(sha256(token)).run();
}

import { OAuth2Client } from 'google-auth-library';
import { getDatabase } from './database.mjs';
import { origin, randomToken, sha256, safeReturnTo, cookie, readCookie, cookieName, safeEqual, allowedEmails, createSession, revokeSession } from './sessions.mjs';
import { readBoundedUtf8 } from '../../lib/request-bounds.ts';
const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const client = () => {
  const oauth = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${origin()}/auth/google/callback`);
  oauth.transporter.defaults = { ...oauth.transporter.defaults, timeout: 10000, retry: false };
  return oauth;
};
function page(title, content, status = 200, headers = {}) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · My Jamaat</title><style>body{font:18px system-ui;background:#f6f8f5;color:#173c2a;margin:0}main{max-width:440px;margin:10vh auto;padding:32px;background:white;border-radius:18px}button,a{font:inherit}button{padding:14px 22px;background:#215d40;color:white;border:0;border-radius:9px;cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #db9700;outline-offset:4px}p{line-height:1.6}</style></head><body><main><h1>My Jamaat</h1>${content}</main></body></html>`, { status, headers: { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store', ...headers } });
}
export async function authRoute(request) {
  const url = new URL(request.url);
  if (!['/signin','/signout','/auth/google/callback','/signin-with-chatgpt','/signout-with-chatgpt'].includes(url.pathname)) return null;
  if (url.pathname.endsWith('-with-chatgpt')) return Response.redirect(`${origin()}${url.pathname.startsWith('/signin')?'/signin':'/signout'}${url.search}`,303);
  if (url.pathname === '/auth/google/callback') return googleCallback(request);
  if (request.method === 'GET') {
    const csrf = randomToken();
    const signout = url.pathname === '/signout';
    return page(signout?'Sign out':'Sign in', `<h2>${signout?'Sign out':'Sign in to your Markaz'}</h2><p>${signout?'End this browser’s My Jamaat session.':'Use your approved Google account to continue. Your Markaz permissions apply after sign-in.'}</p><form action="${signout?'/signout':'/signin'}" method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="return_to" value="${escape(safeReturnTo(url.searchParams.get('return_to')??'/'))}"><button type="submit">${signout?'Sign out':'Continue with Google'}</button></form>`,200,{'set-cookie':cookie('csrf',csrf,600)});
  }
  if (request.method !== 'POST') return new Response(null,{status:405,headers:{allow:'GET, POST'}});
  if (request.headers.get('origin') !== origin()) return page('Request declined',`<p>Please open a fresh form and try again. <a href="${url.pathname}">Try again</a>.</p>`,403);
  let body;
  try { body = new URLSearchParams(await readBoundedUtf8(request, 4096)); } catch { return page('Request declined','<p>Invalid request.</p>',400); }
  if (!safeEqual(body.get('csrf'), readCookie(request.headers.get('cookie'),cookieName('csrf')))) return page('Request declined',`<p>This form expired. <a href="${url.pathname}">Try again</a>.</p>`,403);
  const returnTo = safeReturnTo(body.get('return_to') ?? '/');
  if (url.pathname === '/signout') {
    revokeSession(request.headers.get('cookie'));
    return new Response(null,{status:303,headers:{location:returnTo,'set-cookie':cookie('session','',0)}});
  }
  const state = randomToken(), nonce = randomToken(), verifier = randomToken();
  const sqlite = getDatabase().sqlite;
  sqlite.prepare('DELETE FROM render_login_attempts WHERE expires_at<=?').run(Date.now());
  if (sqlite.prepare('SELECT COUNT(*) AS n FROM render_login_attempts').get().n >= 500) return page('Please try later','<p>Sign-in is busy. Please try again in a few minutes.</p>',429);
  sqlite.prepare('INSERT INTO render_login_attempts VALUES (?,?,?,?,?)').run(sha256(state),nonce,verifier,returnTo,Date.now()+600000);
  const destination = client().generateAuthUrl({scope:['openid','email','profile'], state, nonce, code_challenge:sha256Base64(verifier), code_challenge_method:'S256', prompt:'select_account'});
  return new Response(null,{status:303,headers:{location:destination,'set-cookie':cookie('login',state,600)}});
}
const sha256Base64 = value => Buffer.from(sha256(value),'hex').toString('base64url');
// The client argument allows isolated tests to stub Google's transport. HTTP
// requests always use the real Google client, its token endpoint and certificate verifier.
export async function googleCallback(request, oauth = client()) {
  const url = new URL(request.url), state = url.searchParams.get('state'), code = url.searchParams.get('code');
  if (request.method !== 'GET' || !state || !safeEqual(state,readCookie(request.headers.get('cookie'),cookieName('login')))) return page('Sign-in failed','<p>Sign-in expired or could not be verified. <a href="/signin">Try again</a>.</p>',400);
  const sqlite = getDatabase().sqlite;
  const attempt = sqlite.prepare('DELETE FROM render_login_attempts WHERE state_hash=? RETURNING *').get(sha256(state));
  if (!attempt || attempt.expires_at <= Date.now() || !code || code.length > 4096) return page('Sign-in failed','<p>Sign-in expired. <a href="/signin">Try again</a>.</p>',400);
  try {
    const { tokens } = await oauth.getToken({ code, codeVerifier:attempt.verifier, redirect_uri:`${origin()}/auth/google/callback` });
    if (!tokens.id_token) throw new Error('Missing ID token');
    const ticket = await oauth.verifyIdToken({ idToken:tokens.id_token, audience:process.env.GOOGLE_CLIENT_ID });
    const user = ticket.getPayload();
    if (!user?.sub || user.nonce !== attempt.nonce || !user.email || user.email_verified !== true || !allowedEmails().has(user.email.toLowerCase())) return page('Access not enabled','<p>This Google account has not been enabled for the pilot. Contact your Markaz organizer.</p>',403);
    revokeSession(request.headers.get('cookie'));
    const token = createSession({userId:`google:${user.sub}`,email:user.email,fullName:user.name??null});
    const headers = new Headers({location:attempt.return_to,'cache-control':'no-store'});
    headers.append('set-cookie',cookie('session',token,604800));
    headers.append('set-cookie',cookie('login','',0));
    headers.append('set-cookie',cookie('csrf','',0));
    return new Response(null,{status:303,headers});
  } catch { return page('Sign-in failed','<p>We could not verify your Google account. <a href="/signin">Try again</a>.</p>',400); }
}

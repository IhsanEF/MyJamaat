import { OAuth2Client } from 'google-auth-library';
import { getDatabase } from './database.mjs';
import { origin, randomToken, sha256, safeReturnTo, cookie, readCookie, cookieName, safeEqual, createSession, revokeSession } from './sessions.mjs';
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
  if (['/about','/privacy'].includes(url.pathname)) {
    if (!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405,headers:{allow:'GET, HEAD'}});
    const privacy=url.pathname==='/privacy';
    const content=privacy
      ? `<h2>Privacy</h2><p>My Jamaat helps people organize Markaz and Jamaat activities.</p><h3>Google sign-in</h3><p>We request your Google account identifier, verified email and basic profile name to identify your account and display your name. We do not request access to Gmail, Drive, contacts or calendars. Your Google password stays with Google.</p><h3>App records and access</h3><p>Information you enter, including membership, route plans, messages and activity history, is stored for the app's functions. Access follows Markaz membership and role permissions. Signing in alone does not give access to another Markaz's private records.</p><h3>Storage and providers</h3><p>This deployment uses Google for authentication, Render for hosting and Turso for database storage. These providers process information required to provide their services. Session tokens are stored as hashes and expire after seven days; signing out revokes the current session. Account and activity records are not deleted automatically when you sign out.</p><h3>Your records and requests</h3><p>Signed-in users can export their personal records through the app's history tools. Contact your Markaz organizer or the support address shown on the Google consent screen for questions, corrections or deletion requests. Some shared records and audit history may require organizer review; signing out does not remove them.</p><p><a href="/about">About My Jamaat</a> · <a href="/signin">Sign in</a></p>`
      : `<h2>Organize your Jamaat</h2><p>My Jamaat helps Markaz organizers and members plan Jamaat routes across masajid, choose the number of days at each stop, and coordinate meetings, duties and activity records.</p><p>Sign in with your Google account to create or join a Markaz. Membership and role permissions determine which records you can access.</p><p>Google provides your account identifier, verified email and basic profile name for sign-in. My Jamaat does not request access to your Gmail, Drive or Google calendars.</p><p><a href="/signin">Continue to sign in</a> · <a href="/privacy">Privacy policy</a></p>`;
    const response=page(privacy?'Privacy':'About',content);
    return request.method==='HEAD'?new Response(null,{status:response.status,headers:response.headers}):response;
  }
  if (!['/signin','/signout','/auth/google/callback','/signin-with-chatgpt','/signout-with-chatgpt'].includes(url.pathname)) return null;
  if (url.pathname.endsWith('-with-chatgpt')) return Response.redirect(`${origin()}${url.pathname.startsWith('/signin')?'/signin':'/signout'}${url.search}`,303);
  if (url.pathname === '/auth/google/callback') return googleCallback(request);
  if (request.method === 'GET') {
    const csrf = randomToken();
    const signout = url.pathname === '/signout';
    return page(signout?'Sign out':'Sign in', `<h2>${signout?'Sign out':'Sign in to your Markaz'}</h2><p>${signout?'End this browser’s My Jamaat session.':'Use your Google account to continue. Your Markaz permissions apply after sign-in.'}</p><form action="${signout?'/signout':'/signin'}" method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="return_to" value="${escape(safeReturnTo(url.searchParams.get('return_to')??'/'))}"><button type="submit">${signout?'Sign out':'Continue with Google'}</button></form><p><a href="/about">About My Jamaat</a> · <a href="/privacy">Privacy policy</a></p>`,200,{'set-cookie':cookie('csrf',csrf,600)});
  }
  if (request.method !== 'POST') return new Response(null,{status:405,headers:{allow:'GET, POST'}});
  if (request.headers.get('origin') !== origin()) return page('Request declined',`<p>Please open a fresh form and try again. <a href="${url.pathname}">Try again</a>.</p>`,403);
  let body;
  try { body = new URLSearchParams(await readBoundedUtf8(request, 4096)); } catch { return page('Request declined','<p>Invalid request.</p>',400); }
  if (!safeEqual(body.get('csrf'), readCookie(request.headers.get('cookie'),cookieName('csrf')))) return page('Request declined',`<p>This form expired. <a href="${url.pathname}">Try again</a>.</p>`,403);
  const returnTo = safeReturnTo(body.get('return_to') ?? '/');
  if (url.pathname === '/signout') {
    await revokeSession(request.headers.get('cookie'));
    return new Response(null,{status:303,headers:{location:returnTo,'set-cookie':cookie('session','',0)}});
  }
  const state = randomToken(), nonce = randomToken(), verifier = randomToken();
  const db = getDatabase();
  const attempts = await db.batch([
    db.prepare('DELETE FROM render_login_attempts WHERE expires_at<=?').bind(Date.now()),
    db.prepare('INSERT INTO render_login_attempts SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM render_login_attempts)<500 RETURNING state_hash').bind(sha256(state),nonce,verifier,returnTo,Date.now()+600000),
  ]);
  if (!attempts[1].results.length) return page('Please try later','<p>Sign-in is busy. Please try again in a few minutes.</p>',429);
  const destination = client().generateAuthUrl({scope:['openid','email','profile'], state, nonce, code_challenge:sha256Base64(verifier), code_challenge_method:'S256', prompt:'select_account'});
  return new Response(null,{status:303,headers:{location:destination,'set-cookie':cookie('login',state,600)}});
}
const sha256Base64 = value => Buffer.from(sha256(value),'hex').toString('base64url');
// The client argument allows isolated tests to stub Google's transport. HTTP
// requests always use the real Google client, its token endpoint and certificate verifier.
export async function googleCallback(request, oauth = client()) {
  const url = new URL(request.url), state = url.searchParams.get('state'), code = url.searchParams.get('code');
  if (request.method !== 'GET' || !state || !safeEqual(state,readCookie(request.headers.get('cookie'),cookieName('login')))) return page('Sign-in failed','<p>Sign-in expired or could not be verified. <a href="/signin">Try again</a>.</p>',400);
  const attempt = await getDatabase().prepare('DELETE FROM render_login_attempts WHERE state_hash=? RETURNING *').bind(sha256(state)).first();
  if (!attempt || attempt.expires_at <= Date.now() || !code || code.length > 4096) return page('Sign-in failed','<p>Sign-in expired. <a href="/signin">Try again</a>.</p>',400);
  try {
    const { tokens } = await oauth.getToken({ code, codeVerifier:attempt.verifier, redirect_uri:`${origin()}/auth/google/callback` });
    if (!tokens.id_token) throw new Error('Missing ID token');
    const ticket = await oauth.verifyIdToken({ idToken:tokens.id_token, audience:process.env.GOOGLE_CLIENT_ID });
    const user = ticket.getPayload();
    if (!user?.sub || user.nonce !== attempt.nonce || !user.email || user.email_verified !== true) return page('Sign-in failed','<p>Your Google account could not be verified. <a href="/signin">Try again</a>.</p>',403);
    await revokeSession(request.headers.get('cookie'));
    const token = await createSession({userId:`google:${user.sub}`,email:user.email,fullName:user.name??null});
    const headers = new Headers({location:attempt.return_to,'cache-control':'no-store'});
    headers.append('set-cookie',cookie('session',token,604800));
    headers.append('set-cookie',cookie('login','',0));
    headers.append('set-cookie',cookie('csrf','',0));
    return new Response(null,{status:303,headers});
  } catch { return page('Sign-in failed','<p>We could not verify your Google account. <a href="/signin">Try again</a>.</p>',400); }
}

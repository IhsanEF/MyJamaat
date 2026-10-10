import { getDatabase } from './database.mjs';
import { origin } from './sessions.mjs';
import { authRoute } from './google.mjs';
import { protectResponse } from '../../lib/response-policy.ts';
export async function handleRequest(incoming, framework) {
  const url = new URL(incoming.url);
  const headers = new Headers(incoming.headers);
  for (const key of [...headers.keys()]) if (key.startsWith('oai-authenticated-') || key.startsWith('x-forwarded-') || key === 'forwarded' || key === 'x-audit-persona') headers.delete(key);
  headers.set('host',new URL(origin()).host);
  // PUBLIC_ORIGIN is authoritative; untrusted Host/proxy headers never choose
  // callbacks, redirects, cookie security or the API's same-origin boundary.
  const reader = incoming.body?.getReader();
  let cancelled = false;
  const body = reader ? new ReadableStream({
    async pull(controller) {
      try { const next = await reader.read(); if (!cancelled) { if (next.done) controller.close(); else controller.enqueue(next.value); } }
      catch (error) { if (!cancelled) controller.error(error); }
    },
    cancel(reason) { cancelled = true; return reader.cancel(reason); },
  }) : null;
  const request = new Request(`${origin()}${url.pathname}${url.search}`, {method:incoming.method,headers,...(!['GET','HEAD'].includes(incoming.method)?{body,duplex:'half'}:{})});
  let response;
  try {
    if (url.pathname === '/api/health') {
      if (!['GET','HEAD'].includes(request.method)) response = new Response(null,{status:405,headers:{allow:'GET, HEAD'}});
      else { await getDatabase().prepare('SELECT 1').first(); response=Response.json({status:'ok'}); }
    } else response = await authRoute(request) ?? await framework(request);
  } catch { response = Response.json({error:'Service temporarily unavailable.'},{status:503}); }
  finally {
    // The Node bridge pauses unread bodies. Release early-denial bodies (e.g.
    // Content-Length rejection) so a following keep-alive request is not stuck.
    cancelled = true;
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  response = protectResponse(response,request);
  response.headers.set('Cache-Control','private, no-store');
  // no-referrer makes browser form navigation send Origin:null. Same-origin
  // retains our CSRF origin check and still withholds referrers from Google.
  if (url.pathname === '/signin' || url.pathname === '/signout') response.headers.set('Referrer-Policy','same-origin');
  if (url.pathname === '/signin') response.headers.set('Content-Security-Policy', response.headers.get('Content-Security-Policy').replace("form-action 'self'", "form-action 'self' https://accounts.google.com"));
  return response;
}

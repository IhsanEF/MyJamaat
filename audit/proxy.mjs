// Local audit harness only. This file is not imported by application code.
import http from "node:http";
import { readFileSync } from "node:fs";

const personas = JSON.parse(readFileSync(new URL("./personas.json", import.meta.url), "utf8"));
const byKey = new Map(personas.map(persona => [persona.key, persona]));
const sessions = process.env.AUDIT_SESSION_FILE ? JSON.parse(readFileSync(process.env.AUDIT_SESSION_FILE,"utf8")) : null;
const host = "127.0.0.1";
const port = Number(process.env.AUDIT_PROXY_PORT || 5181);
const workerPort = Number(process.env.AUDIT_WORKER_PORT || 5180);
const publicOrigin = `http://${host}:${port}`;
const upstreamOrigin = `http://${host}:${workerPort}`;
const escape = value => String(value).replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]));

const server = http.createServer((request, response) => {
  const hostname = String(request.headers.host || "").split(":")[0];
  const hostPersona = hostname.endsWith(".localhost") ? byKey.get(hostname.slice(0,-".localhost".length)) : null;
  if (request.headers.host !== `${host}:${port}` && request.headers.host !== `localhost:${port}` && (!hostPersona || request.headers.host !== `${hostPersona.key}.localhost:${port}`)) {
    response.writeHead(403, {"content-type":"text/plain"});
    response.end("The audit proxy only accepts its localhost host name.");
    return;
  }
  const incomingOrigin = `http://${request.headers.host}`;
  const url = new URL(request.url, incomingOrigin);
  if (url.pathname === "/__test/personas") {
    response.writeHead(200, {"content-type":"application/json", "cache-control":"no-store"});
    response.end(JSON.stringify(personas));
    return;
  }
  if (url.pathname === "/__test/persona") {
    const selected = byKey.get(url.searchParams.get("as"));
    if (selected) {
      response.writeHead(303, {"location":`http://${selected.key}.localhost:${port}/`, "set-cookie":`audit_persona=${selected.key}; Path=/; HttpOnly; SameSite=Strict`, "cache-control":"no-store"});
      response.end();
      return;
    }
    response.writeHead(200, {"content-type":"text/html; charset=utf-8", "cache-control":"no-store"});
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Local My Jamaat audit personas</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:20px system-ui;line-height:1.5;max-width:900px;margin:32px auto;padding:20px}li{margin:24px 0}a{display:block;padding:12px}small{display:block}</style><h1>Local audit personas</h1><p>Synthetic records only. Select an identity for this browser. Each persona has a separate localhost origin, allowing simultaneous tabs without cookie collisions. Changes affect the isolated local audit database.</p><ul>${personas.map(p => `<li><a href="http://${encodeURIComponent(p.key)}.localhost:${port}/">${escape(p.name)} — ${escape(p.role)}</a><small>${escape(p.technology)}${p.languages.length?` · ${escape(p.languages.join(", "))}`:""}</small></li>`).join("")}</ul></html>`);
    return;
  }
  if (url.pathname === "/signin-with-chatgpt" || url.pathname === "/signout-with-chatgpt") {
    response.writeHead(303, {"location":"/__test/persona", "cache-control":"no-store"});
    response.end();
    return;
  }
  const cookie = String(request.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("audit_persona="));
  const persona = hostPersona || byKey.get(String(request.headers["x-audit-persona"] || "")) || byKey.get(cookie?.slice("audit_persona=".length) || "anonymous");
  const headers = {...request.headers, host:`${host}:${workerPort}`};
  // Simulate the trusted hosting boundary: discard all caller identity headers.
  for (const key of Object.keys(headers)) {
    if (key.startsWith("oai-authenticated-") || key === "x-audit-persona" || key === "x-forwarded-host" || key === "x-forwarded-proto") delete headers[key];
  }
  if (sessions) {
    // Only the isolated harness owns these random sessions; the production
    // server verifies opaque tokens in its database and ignores identity headers.
    const retained=String(request.headers.cookie||"").split(";").map(value=>value.trim()).filter(value=>value&&!value.startsWith("mj_session=")&&!value.startsWith("audit_persona="));
    headers.cookie = [sessions[persona?.key] ? `mj_session=${sessions[persona.key]}` : "",...retained].filter(Boolean).join("; ");
  } else if (persona?.authId) {
    headers["oai-authenticated-user-id"] = persona.authId;
    headers["oai-authenticated-user-email"] = persona.email;
    headers["oai-authenticated-user-full-name"] = encodeURIComponent(persona.name);
    headers["oai-authenticated-user-full-name-encoding"] = "percent-encoded-utf-8";
  }
  // Preserve a foreign Origin so cross-site checks remain testable.
  if (headers.origin === incomingOrigin) headers.origin = sessions ? publicOrigin : upstreamOrigin;
  const upstream = http.request(new URL(request.url, upstreamOrigin), {method:request.method, headers}, upstreamResponse => {
    const resultHeaders = {...upstreamResponse.headers};
    if (typeof resultHeaders.location === "string" && resultHeaders.location.startsWith(upstreamOrigin)) resultHeaders.location = incomingOrigin + resultHeaders.location.slice(upstreamOrigin.length);
    response.writeHead(upstreamResponse.statusCode || 502, resultHeaders);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, {"content-type":"application/json"});
    response.end(JSON.stringify({error:"Local audit Worker is unavailable. Start the built Worker on port 5180."}));
  });
  request.pipe(upstream);
});

server.listen(port, host, () => process.stdout.write(`Audit proxy: ${publicOrigin}/__test/persona\nBuilt Worker target: ${upstreamOrigin}\n`));

// Import this helper in local review scripts. Requests cannot target a live site.
export const auditBase = process.env.AUDIT_BASE || "http://127.0.0.1:5181";
const target = new URL(auditBase);
if (!["127.0.0.1","localhost"].includes(target.hostname) && !target.hostname.endsWith(".localhost")) throw new Error("Audit requests must target loopback.");
export async function api(persona, body, options={}) {
  const response = await fetch(`${auditBase}${options.path||"/api/app"}`,{
    method:body===undefined?"GET":"POST",
    headers:{"x-audit-persona":persona,...(body===undefined?{}:{"content-type":"application/json"}),...options.headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
    redirect:"manual"
  });
  const raw = await response.text();
  let data;
  try { data=JSON.parse(raw); } catch { data=raw; }
  return {status:response.status,data,headers:Object.fromEntries(response.headers)};
}

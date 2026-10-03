const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join("; ");

export function protectResponse(response:Response,request:Request):Response {
  const headers=new Headers(response.headers);
  headers.set("Content-Security-Policy",contentSecurityPolicy);
  headers.set("X-Content-Type-Options","nosniff");
  headers.set("Referrer-Policy","no-referrer");
  headers.set("Permissions-Policy","camera=(), microphone=(), geolocation=()");
  if(new URL(request.url).pathname.startsWith("/api/"))headers.set("Cache-Control","private, no-store");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

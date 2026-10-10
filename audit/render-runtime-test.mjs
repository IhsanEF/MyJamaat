// Synthetic, disposable production-runtime tests. No Google credentials, network
// provider account, ordinary preview database, or live records are used.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { OAuth2Client } from 'google-auth-library';
import { getDatabase, SqliteDatabase, migrate, migrateLibsql } from '../runtime/render/database.mjs';
import { createSession, verifiedUser, sha256, cookieName, validateConfiguration, safeReturnTo, randomToken } from '../runtime/render/sessions.mjs';
import { authRoute, googleCallback } from '../runtime/render/google.mjs';
import { handleRequest } from '../runtime/render/handler.mjs';
const directory=mkdtempSync(join(tmpdir(),'my-jamaat-render-tests-'));
const checks=[];
const libsql=process.argv.includes('--libsql');
let child;
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
const portServer=net.createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));
const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
const base=`http://127.0.0.1:${port}`;
Object.assign(process.env,{PORT:String(port),PUBLIC_ORIGIN:base,SQLITE_PATH:join(directory,'app.sqlite'),GOOGLE_CLIENT_ID:'synthetic-client',GOOGLE_CLIENT_SECRET:'synthetic-not-a-secret',ALLOWED_SIGN_IN_EMAILS:'allowed@example.test'});
process.env.TURSO_DATABASE_URL=libsql ? `file:${join(directory,'app.sqlite')}` : '';
delete process.env.TURSO_AUTH_TOKEN;
const request=(path,options={})=>new Request(`${base}${path}`,options);
const cookieHeader=(purpose,token)=>`${cookieName(purpose)}=${token}`;
const start=async()=>{
  const logs=[];
  let last='';
  child=spawn(process.execPath,['scripts/start-render.mjs'],{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>logs.push(String(x)));child.stderr.on('data',x=>logs.push(String(x)));
  for(let n=0;n<100;n++) {
    if(child.exitCode!==null)throw new Error(`Production server stopped: ${logs.join('').slice(-1000)}`);
    try{const response=await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(500)});last=`${response.status}: ${await response.text()}`;if(response.status===200)return;}catch(error){last=error.message;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error(`Production server readiness timed out: ${last}; ${logs.join('').slice(-1000)}`);
};
const stop=async()=>{
  if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}
};
try {
  validateConfiguration();const db=getDatabase();await db.ready;
  const query=(sql,...values)=>db.prepare(sql).bind(...values).first();
  const rows=async sql=>(await db.prepare(sql).all()).results;
  const run=(sql,...values)=>db.prepare(sql).bind(...values).run();
  check('all 14 production migrations applied once',(await query('SELECT COUNT(*) AS n FROM render_migrations')).n===14);
  const before=await rows('SELECT * FROM render_migrations ORDER BY name');if(libsql)await migrateLibsql(db);else migrate(db);
  check('restart migration tracking unchanged',JSON.stringify(before)===JSON.stringify(await rows('SELECT * FROM render_migrations ORDER BY name')));
  await run('CREATE TABLE adapter_probe (id INTEGER PRIMARY KEY, value TEXT UNIQUE)');
  await db.batch([db.prepare('INSERT INTO adapter_probe VALUES (?,?)').bind(1,'one'),db.prepare('INSERT INTO adapter_probe VALUES (?,?)').bind(2,'two')]);
  await assert.rejects(()=>db.batch([db.prepare('INSERT INTO adapter_probe VALUES (?,?)').bind(3,'three'),db.prepare('INSERT INTO adapter_probe VALUES (?,?)').bind(4,'one')]));
  check('batch rollback leaves no partial write',(await db.prepare('SELECT COUNT(*) AS n FROM adapter_probe').first('n'))===2);
  check('UPDATE RETURNING includes rows and change count',(await db.prepare('UPDATE adapter_probe SET value=? WHERE id=? RETURNING id').bind('updated',2).run()).meta.changes===1);
  check('D1 all and raw result shapes',(await db.prepare('SELECT value FROM adapter_probe ORDER BY id').all()).results.length===2&&(await db.prepare('SELECT value FROM adapter_probe ORDER BY id').raw({columnNames:true}))[0][0]==='value');
  check('no open return URL',['https://evil.test','//evil.test','/\\evil.test','/signin','/auth/google/callback'].every(value=>safeReturnTo(value)==='/'));
  const signin=await authRoute(request('/signin?return_to=%2F%2Fevil.test'));
  const html=await signin.text();const csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
  check('sign-in form has CSRF cookie',signin.headers.get('set-cookie').includes('HttpOnly')&&signin.headers.get('set-cookie').includes('SameSite=Lax'));
  const postOptions={method:'POST',headers:{origin:base,cookie:cookieHeader('csrf',csrf),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,return_to:'/'}).toString()};
  check('foreign sign-in Origin denied',(await authRoute(request('/signin',{...postOptions,headers:{...postOptions.headers,origin:'https://evil.test'}}))).status===403);
  check('missing sign-in CSRF denied',(await authRoute(request('/signin',{...postOptions,body:'csrf=wrong'}))).status===403);
  const oauthStart=await authRoute(request('/signin',postOptions));const location=new URL(oauthStart.headers.get('location'));const state=location.searchParams.get('state');
  const attempt=await query('SELECT * FROM render_login_attempts WHERE state_hash=?',sha256(state));
  check('Google authorization uses PKCE, state and nonce',location.origin==='https://accounts.google.com'&&location.searchParams.get('code_challenge_method')==='S256'&&location.searchParams.get('code_challenge')===Buffer.from(sha256(attempt.verifier),'hex').toString('base64url')&&location.searchParams.get('nonce')===attempt.nonce);
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const certs={synthetic:publicKey.export({type:'spki',format:'pem'})};
  const oauth=new OAuth2Client('synthetic-client');
  oauth.getFederatedSignonCertsAsync=async()=>({certs});
  let payload={iss:'https://accounts.google.com',aud:'synthetic-client',sub:'synthetic-subject',email:'allowed@example.test',email_verified:true,name:'Synthetic Organizer',nonce:attempt.nonce,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600};
  let tamper=false;
  oauth.getToken=async()=>{
    const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'synthetic'})).toString('base64url');
    const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature=sign('RSA-SHA256',Buffer.from(`${header}.${body}`),privateKey).toString('base64url');
    return {tokens:{id_token:`${header}.${body}.${tamper?randomToken():signature}`}};
  };
  const seedAttempt=async()=>{const state=randomToken();await run('INSERT INTO render_login_attempts VALUES (?,?,?,?,?)',sha256(state),attempt.nonce,attempt.verifier,'/',Date.now()+600000);return state;};
  const callback=state=>request(`/auth/google/callback?state=${state}&code=synthetic-code`,{headers:{cookie:cookieHeader('login',state)}});
  check('callback without matching state cookie denied',(await googleCallback(request(`/auth/google/callback?state=${state}&code=x`),oauth)).status===400);
  const good={...payload};
  for(const [name,change,status] of [
    ['wrong audience',{aud:'foreign-client'},400],['wrong issuer',{iss:'https://evil.test'},400],
    ['expired token',{iat:1,exp:2},400],['wrong nonce',{nonce:'wrong'},403],
    ['unverified email',{email_verified:false},403],['unapproved pilot email',{email:'denied@example.test'},403],
  ]){payload={...good,...change};check(`Google ${name} denied`,(await googleCallback(callback(await seedAttempt()),oauth)).status===status);}
  payload=good;tamper=true;check('Google tampered signature denied',(await googleCallback(callback(await seedAttempt()),oauth)).status===400);tamper=false;
  const finalState=await seedAttempt();const loggedIn=await googleCallback(callback(finalState),oauth);
  const sessionCookie=loggedIn.headers.getSetCookie().find(value=>value.startsWith(`${cookieName('session')}=`)).split(';')[0];
  check('verified callback creates opaque session',loggedIn.status===303&&(await verifiedUser(sessionCookie))?.userId==='google:synthetic-subject');
  check('callback replay denied',(await googleCallback(callback(finalState),oauth)).status===400);
  check('session DB stores a hash only',(await query('SELECT token_hash FROM render_sessions')).token_hash!==sessionCookie.split('=')[1]);
  check('no old hosting identity auto-link',(await verifiedUser(sessionCookie)).userId!=='audit-auth-admin');
  const expired=await createSession({userId:'expired',email:'allowed@example.test'});await run('UPDATE render_sessions SET expires_at=0 WHERE token_hash=?',sha256(expired));
  check('expired sessions denied',(await verifiedUser(cookieHeader('session',expired)))===null);
  check('duplicate session cookies denied',(await verifiedUser(`${sessionCookie}; ${sessionCookie}`))===null);
  const forged=randomToken();check('unknown session token denied',(await verifiedUser(cookieHeader('session',forged)))===null);
  process.env.ALLOWED_SIGN_IN_EMAILS='other@example.test';check('pilot access revocation immediate',(await verifiedUser(sessionCookie))===null);process.env.ALLOWED_SIGN_IN_EMAILS='allowed@example.test';
  await run('DELETE FROM render_login_attempts');
  await db.batch(Array.from({length:499},()=>db.prepare('INSERT INTO render_login_attempts VALUES (?,?,?,?,?)').bind(sha256(randomToken()),randomToken(),randomToken(),'/',Date.now()+600000)));
  const lastSlots=await Promise.all([authRoute(request('/signin',postOptions)),authRoute(request('/signin',postOptions))]);
  check('concurrent login requests cannot exceed the pending cap',lastSlots.map(response=>response.status).sort().join(',')==='303,429');
  check('pending login count remains exactly 500',(await query('SELECT COUNT(*) AS n FROM render_login_attempts')).n===500);
  await run('DELETE FROM render_login_attempts');
  const httpsOrigin='https://my-jamaat.example.test';process.env.PUBLIC_ORIGIN=httpsOrigin;
  check('HTTPS cookies use __Host scope',cookieName('session')==='__Host-mj_session');process.env.PUBLIC_ORIGIN=base;
  const stripped=await handleRequest(request('/api/probe',{headers:{'oai-authenticated-user-id':'forged','x-forwarded-host':'evil.test'}}),async sanitized=>Response.json({stripped:!sanitized.headers.has('oai-authenticated-user-id')&&!sanitized.headers.has('x-forwarded-host'),origin:new URL(sanitized.url).origin}));
  const strippedData=await stripped.json();check('Node boundary strips identity and proxy headers',strippedData.stripped&&strippedData.origin===base);
  await start();
  const health=await fetch(`${base}/api/health`,{redirect:'manual'});check('live readiness returns direct private 200',health.status===200&&JSON.stringify(await health.json())==='{"status":"ok"}'&&health.headers.get('cache-control')==='private, no-store');
  const anonymous=await fetch(`${base}/api/app`,{headers:{'oai-authenticated-user-id':'google:synthetic-subject','oai-authenticated-user-email':'allowed@example.test'}});check('direct live API rejects forged hosting headers',anonymous.status===401);
  const privatePage=await fetch(base,{redirect:'manual'});check('anonymous page redirects to independent sign-in',privatePage.status===307&&privatePage.headers.get('location').startsWith('/signin'));
  const apiHeaders={cookie:sessionCookie,'content-type':'application/json',origin:base};
  const setup=await fetch(`${base}/api/app`,{headers:apiHeaders});check('verified Google session reaches empty setup',(await setup.json()).setup==='create-markaz');
  const created=await fetch(`${base}/api/app`,{method:'POST',headers:apiHeaders,body:JSON.stringify({action:'createMarkaz',name:'Synthetic Render Markaz',yourName:'Synthetic Organizer',timeZone:'America/Vancouver'})});check('verified session creates synthetic Markaz',created.status===200);
  const first=await (await fetch(`${base}/api/app`,{headers:apiHeaders})).json();
  await stop();await start();const second=await (await fetch(`${base}/api/app`,{headers:apiHeaders})).json();
  check('restart preserves Markaz, person and session',first.markaz.id===second.markaz.id&&first.me.id===second.me.id);
  const backupFile=join(directory,'backup.sqlite');const backed=spawnSync(process.execPath,['scripts/backup-render.mjs',backupFile],{env:{...process.env,TURSO_DATABASE_URL:''},encoding:'utf8'});
  check('consistent live WAL backup succeeds',backed.status===0&&existsSync(backupFile));
  const restored=new SqliteDatabase(backupFile);migrate(restored);check('backup restore preserves identities and history',restored.sqlite.prepare('SELECT auth_id FROM people WHERE id=?').get(first.me.id).auth_id==='google:synthetic-subject'&&restored.sqlite.prepare('SELECT COUNT(*) AS n FROM audit').get().n===(await query('SELECT COUNT(*) AS n FROM audit')).n);restored.close();
  const signoutPage=await authRoute(request('/signout'));const logoutCsrf=(await signoutPage.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const logout=await authRoute(request('/signout',{method:'POST',headers:{origin:base,cookie:`${sessionCookie}; ${cookieHeader('csrf',logoutCsrf)}`},body:new URLSearchParams({csrf:logoutCsrf}).toString()}));
  check('logout revokes server session',logout.status===303&&(await verifiedUser(sessionCookie))===null&&(await fetch(`${base}/api/app`,{headers:apiHeaders})).status===401);
  await stop();db.close();const unavailable=await handleRequest(request('/api/health'),()=>Response.json({wrong:true}));check('unavailable database returns bounded readiness 503',unavailable.status===503&&(await unavailable.text()).includes('Service temporarily unavailable'));
  const report={status:'PASS',runtime:libsql?'production Node with official libSQL client on disposable local file':'production Node with local SQLite',startedWith:'npm run start:render',checks,googleVerification:'Real OAuth2Client signature/issuer/audience/expiry validation with synthetic RSA certificates; provider transport stubbed only in test',liveGoogleLogin:'Pending real OAuth client configuration',renderDiskPersistence:libsql?'Local libSQL restart and isolated backup restore passed; live Turso transport and Render restart pending':'Local restart and isolated backup restore passed; actual Render disk/redeploy pending'};
  writeFileSync(libsql?'audit/turso-runtime-verification.json':'audit/render-runtime-verification.json',JSON.stringify(report,null,2)+'\n');console.log(`${checks.length} Render runtime/authentication checks passed`);
} finally {await stop();rmSync(directory,{recursive:true,force:true});}

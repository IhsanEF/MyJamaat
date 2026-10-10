// Local synthetic browser proxy with real database-backed opaque sessions.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { SqliteDatabase, migrate } from '../runtime/render/database.mjs';
const directory=mkdtempSync(join(tmpdir(),'my-jamaat-render-browser-'));
const children=[];
const port=async()=>{const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;};
const workerPort=await port(),proxyPort=await port();
const filename=join(directory,'browser.sqlite');const db=new SqliteDatabase(filename);
const baseFile='0000_conscious_ben_urich.sql';const baseSql=readFileSync(`drizzle/${baseFile}`,'utf8');
db.sqlite.exec(baseSql);db.sqlite.exec(readFileSync('audit/fixture.sql','utf8'));
db.sqlite.exec('CREATE TABLE render_migrations (name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');
db.sqlite.prepare('INSERT INTO render_migrations VALUES (?,?,?)').run(baseFile,createHash('sha256').update(baseSql).digest('hex'),new Date().toISOString());migrate(db);
const personas=JSON.parse(readFileSync('audit/personas.json','utf8')),tokens={};
for(const p of personas.filter(row=>row.authId)){const token=randomBytes(32).toString('base64url');tokens[p.key]=token;db.sqlite.prepare('INSERT INTO render_sessions VALUES (?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),p.authId,p.email,p.name,Date.now()+7*86400000);}
db.close();const sessionFile=join(directory,'sessions.json');writeFileSync(sessionFile,JSON.stringify(tokens),{mode:0o600});
const libsql=process.argv.includes('--libsql');
const env={...process.env,TURSO_DATABASE_URL:libsql?`file:${filename}`:'',TURSO_AUTH_TOKEN:'',SQLITE_PATH:filename,PORT:String(workerPort),PUBLIC_ORIGIN:`http://127.0.0.1:${proxyPort}`,GOOGLE_CLIENT_ID:'synthetic-client',GOOGLE_CLIENT_SECRET:'synthetic-not-a-credential',ALLOWED_SIGN_IN_EMAILS:personas.filter(p=>p.authId).map(p=>p.email).join(','),AUDIT_SESSION_FILE:sessionFile,AUDIT_WORKER_PORT:String(workerPort),AUDIT_PROXY_PORT:String(proxyPort)};
for(const script of ['scripts/start-render.mjs','audit/proxy.mjs']){const child=spawn(process.execPath,[script],{env,stdio:'inherit'});children.push(child);}
writeFileSync('audit/render-browser-session.json',JSON.stringify({runtime:'production Node',workerPort,proxyPort,disposable:true,startedAt:new Date().toISOString()},null,2)+'\n');
console.log(`Synthetic browser: http://markaz-ameer.localhost:${proxyPort}/ ; Direct sign-in: http://127.0.0.1:${workerPort}/signin`);
let closing=false;
const cleanup=async()=>{if(closing)return;closing=true;for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');await new Promise(resolve=>setTimeout(resolve,500));rmSync(directory,{recursive:true,force:true});process.exit();};
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,cleanup);

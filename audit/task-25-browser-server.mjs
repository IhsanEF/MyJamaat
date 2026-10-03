// Disposable browser walkthrough; defaults preserve the Task 25 entrypoint.
import {spawn,spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const directory=mkdtempSync(path.join(os.tmpdir(),"my-jamaat-task25-browser-"));
async function port(){const s=net.createServer();await new Promise((yes,no)=>s.once("error",no).listen(0,"127.0.0.1",yes));const p=s.address().port;await new Promise(yes=>s.close(yes));return p;}
const workerPort=await port(),proxyPort=await port();
const env={...process.env,AUDIT_PERSIST_DIR:directory,AUDIT_WORKER_PORT:String(workerPort),AUDIT_PROXY_PORT:String(proxyPort)};
const children=[];
const record={startedAt:new Date().toISOString(),scope:"disposable synthetic browser test; loopback only",directory,workerPort,proxyPort,sourceHash:createHash("sha256").update(readFileSync(path.join(root,"app/api/app/route.ts"))).digest("hex"),buildHash:createHash("sha256").update(readFileSync(path.join(root,"dist/server/index.js"))).digest("hex")};
const manifest=path.join(root,process.argv[2]||"audit/repair-task-25-browser-session.json");
let closing=false;
async function cleanup(){if(closing)return;closing=true;for(const child of children)if(child.exitCode===null)child.kill("SIGTERM");await new Promise(yes=>setTimeout(yes,700));rmSync(directory,{recursive:true,force:true});record.finishedAt=new Date().toISOString();record.cleanedUp=true;writeFileSync(manifest,JSON.stringify(record,null,2)+"\n");process.exit();}
for(const signal of ["SIGTERM","SIGINT"])process.on(signal,cleanup);
try{
 const migrations=JSON.parse(readFileSync(path.join(root,"drizzle/meta/_journal.json"),"utf8")).entries.map(row=>`drizzle/${row.tag}.sql`);
 const files=[migrations[0],"audit/fixture.sql","audit/repair-task-03-legacy-fixture.sql",...migrations.slice(1)];
 for(const file of files){const r=spawnSync(process.execPath,["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file",file],{cwd:root,env,encoding:"utf8",timeout:120000});if(r.error||r.status!==0)throw new Error(`${file}: ${r.error||r.stderr||r.stdout}`);}
 record.migrations=files;
 for(const file of ["audit/worker.mjs","audit/proxy.mjs"]){const child=spawn(process.execPath,[file],{cwd:root,env,stdio:["ignore","pipe","pipe"]});children.push(child);child.stdout.on("data",data=>process.stdout.write(data));child.stderr.on("data",data=>process.stderr.write(data));}
 writeFileSync(manifest,JSON.stringify(record,null,2)+"\n");console.log(JSON.stringify(record,null,2));
}catch(error){console.error(error);process.exitCode=1;await cleanup();}

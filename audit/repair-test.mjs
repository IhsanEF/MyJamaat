// Task 01 regression entry point. Every invocation uses disposable, synthetic D1 state.
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSheet } from "read-excel-file/node";
import { localDateTimeInput, localDay } from "../lib/schedule-time.ts";
import { ledgerDelta } from "../lib/baraka.ts";
import { preflightXlsx, boundSheets } from "../lib/roster-import.ts";
import { readBoundedUtf8, RequestBodyError } from "../lib/request-bounds.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const suite = process.argv[2] || "all";
if (!["all", "daily", "authorization-baseline", "isolation", "dependency-smoke", "validation", "ameer", "permissions", "revocation", "resolution", "onboarding", "import", "privacy", "time", "route", "series", "mashwara", "ijtema", "baraka", "recorded", "places", "everyday", "concurrency", "pagination", "abuse", "history", "recovery"].includes(suite)) {
  throw new Error("Select all, daily, authorization-baseline, isolation, dependency-smoke, validation, ameer, permissions, revocation, resolution, onboarding, import, privacy, time, route, series, mashwara, ijtema, baraka, or recorded.");
}
const reproduce=process.argv.includes("--reproduce");
const tursoRuntime=process.argv.includes("--runtime=turso");
const nodeRuntime=process.argv.includes("--runtime=node")||tursoRuntime;
const outputArg = process.argv.find(value => value.startsWith("--output="));
const output = outputArg ? path.resolve(outputArg.slice(9)) : path.join(root, "audit/repair-task-01-verification.json");
const sha256 = file => createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
const buildHash = nodeRuntime ? createHash("sha256").update(readdirSync(path.join(root,"dist"),{recursive:true}).filter(name=>/\.(?:js|mjs|json|css)$/.test(String(name))).sort().map(name=>String(name)+readFileSync(path.join(root,"dist",name),"utf8")).join("\n")).digest("hex") : sha256("dist/server/index.js");
const sourceHash = sha256("app/api/app/route.ts");
const runtimeHash = nodeRuntime ? createHash("sha256").update([...readdirSync(path.join(root,"runtime/render")).map(name=>`runtime/render/${name}`),"lib/request-bounds.ts","lib/response-policy.ts"].sort().map(name=>name+readFileSync(path.join(root,name),"utf8")).join("\n")).digest("hex") : null;
const result = {suite, runtimeHash, runtime:tursoRuntime?"libsql-local":nodeRuntime?"node":"cloudflare", startedAt:new Date().toISOString(), sourceHash, buildHash, classifications:[], sessions:[], errors:[]};

function command(args, env={}) {
  if(nodeRuntime && args.includes("d1") && args.includes("execute")) {
    const db=new DatabaseSync(path.join(env.AUDIT_PERSIST_DIR,"render.sqlite"));
    try {
      const fileIndex=args.indexOf("--file"), sqlIndex=args.indexOf("--command");
      const file=fileIndex>=0?args[fileIndex+1]:null;
      const sql=file?readFileSync(path.resolve(root,file),"utf8"):args[sqlIndex+1];
      let stdout="";
      if(sql.trim().startsWith("EXPLAIN"))stdout=JSON.stringify(db.prepare(sql).all());
      else db.exec(sql);
      if(file?.startsWith("drizzle/")) {
        db.exec("CREATE TABLE IF NOT EXISTS render_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)");
        db.prepare("INSERT INTO render_migrations VALUES (?,?,?)").run(path.basename(file),createHash("sha256").update(sql).digest("hex"),new Date().toISOString());
      }
      return {command:`Node SQLite isolated SQL: ${file??"bounded fixture/query"}`,stdout};
    } finally {db.close();}
  }
  const run = spawnSync(process.execPath, args, {cwd:root, env:{...process.env,...env}, encoding:"utf8", timeout:120000});
  if (run.error || run.status !== 0) throw new Error(`${args.join(" ")} failed (${run.status}; ${run.error || "no spawn error"}): ${run.stderr || run.stdout || "no command output"}`);
  return {command:`node ${args.join(" ")}`, stdout:run.stdout.trim()};
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve,reject)=>server.once("error",reject).listen(0,"127.0.0.1",resolve));
  const port = server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
async function waitFor(base, child, logs, empty=false) {
  for(let i=0;i<100;i++) {
    if (child.exitCode !== null) throw new Error(`Local server exited early: ${logs.join("").slice(-3000)}`);
    try {
      const response = await fetch(`${base}/api/app`, {headers:{"x-audit-persona":empty?"new":"admin"},signal:AbortSignal.timeout(1000)});
      const payload=await response.json();
      if(nodeRuntime && i===5)logs.push(`Node readiness HTTP ${response.status}: ${JSON.stringify(payload).slice(0,500)}\n`);
      if (response.status===200 && (empty?payload.setup==="create-markaz":payload.me?.id==="p-admin")) return;
    } catch {}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error(`Local server did not become ready: ${logs.join("").slice(-3000)}`);
}
async function session(label, test, extraFixture, empty=false, recovery={}) {
  const directory = mkdtempSync(path.join(os.tmpdir(),"my-jamaat-repair-"));
  const workerPort = await freePort(), proxyPort = await freePort();
  const env = {AUDIT_PERSIST_DIR:directory,AUDIT_WORKER_PORT:String(workerPort),AUDIT_PROXY_PORT:String(proxyPort)};
  const base = `http://127.0.0.1:${proxyPort}`;
  const record = {label, persistence:"disposable isolated directory", workerPort, proxyPort, sourceHash, buildHash, checks:[]};
  result.sessions.push(record);
  const logs=[];
  let worker,proxy;
  try {
    if(recovery.restoreSql) {
      record.restore=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file",recovery.restoreSql],env).command;
    } else {
    record.schema=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0000_conscious_ben_urich.sql"],env).command;
    if (!empty) record.fixture=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","audit/fixture.sql"],env).command;
    if (extraFixture) record.extraFixture=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file",extraFixture],env).command;
    }
    if(recovery.beforeMigrations) await recovery.beforeMigrations(record,{directory,env});
    if(!recovery.restoreSql || recovery.applyMigrations) {
    record.forwardMigration=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0001_romantic_cable.sql"],env).command;
    record.permissionMigration=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0002_misty_captain_cross.sql"],env).command;
    record.invitationMigration=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0003_narrow_shriek.sql"],env).command;
    record.timeMigration=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0004_melodic_cerebro.sql"],env).command;
    record.routeMigration=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0005_busy_sunfire.sql"],env).command;
    record.seriesMigration=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0006_open_valeria_richards.sql"],env).command;
    record.dailyAssignmentReviewMigration=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0007_repair_daily_assignments.sql"],env).command;
    record.barakaMigration=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0008_cheerful_dakota_north.sql"],env).command;
    record.recordedRevisionMigration=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0009_icy_unus.sql"],env).command;
    record.directoryCandidateMigration=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0010_famous_agent_zero.sql"],env).command;
    record.workspacePageMigration=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0011_workspace_page.sql"],env).command;
    record.abuseControlMigration=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0012_abuse_counters.sql"],env).command;
    record.auditLifecycleMigration=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--file","drizzle/0013_audit_lifecycle.sql"],env).command;
    }
    if(label.startsWith("Task 21 paginated"))record.pageQueryPlan=command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--command","EXPLAIN QUERY PLAN SELECT * FROM objects WHERE markaz_id='markaz-surrey' ORDER BY CASE WHEN kind IN ('jamaat','event','stay','team','duty','assignment') THEN 0 WHEN kind='mashwara' AND COALESCE(CASE WHEN json_valid(data) THEN json_extract(data,'$.visibility') ELSE NULL END,'markaz')<>'private' THEN 1 WHEN kind='mashwara' THEN 2 WHEN kind='place' THEN 3 ELSE 4 END,created_at DESC,id DESC LIMIT 501"],env).stdout;
    if(nodeRuntime) {
      const personas=JSON.parse(readFileSync(path.join(root,"audit/personas.json"),"utf8"));
      const db=new DatabaseSync(path.join(directory,"render.sqlite"));
      db.exec("CREATE TABLE IF NOT EXISTS render_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,email TEXT NOT NULL,full_name TEXT,expires_at INTEGER NOT NULL)");
      const tokens={};
      for(const persona of personas.filter(row=>row.authId)) {
        const token=randomBytes(32).toString("base64url");tokens[persona.key]=token;
        db.prepare("INSERT INTO render_sessions VALUES (?,?,?,?,?)").run(createHash("sha256").update(token).digest("hex"),persona.authId,persona.email,persona.name,Date.now()+3600000);
      }
      db.close();
      env.AUDIT_SESSION_FILE=path.join(directory,"sessions.json");
      writeFileSync(env.AUDIT_SESSION_FILE,JSON.stringify(tokens),{mode:0o600});
      env.TURSO_DATABASE_URL=tursoRuntime?`file:${path.join(directory,"render.sqlite")}`:"";env.TURSO_AUTH_TOKEN="";
      env.SQLITE_PATH=path.join(directory,"render.sqlite");env.PORT=String(workerPort);env.PUBLIC_ORIGIN=base;
      env.GOOGLE_CLIENT_ID="synthetic-client";env.GOOGLE_CLIENT_SECRET="synthetic-not-a-credential";
      env.ALLOWED_SIGN_IN_EMAILS=personas.filter(row=>row.authId).map(row=>row.email).join(",");
    }
    worker=spawn(process.execPath,[nodeRuntime?"scripts/start-render.mjs":"audit/worker.mjs"],{cwd:root,env:{...process.env,...env},stdio:["ignore","pipe","pipe"]});
    for (const stream of [worker.stdout,worker.stderr]) stream.on("data",chunk=>logs.push(String(chunk)));
    proxy=spawn(process.execPath,["audit/proxy.mjs"],{cwd:root,env:{...process.env,...env},stdio:["ignore","pipe","pipe"]});
    for (const stream of [proxy.stdout,proxy.stderr]) stream.on("data",chunk=>logs.push(String(chunk)));
    await waitFor(base,proxy,logs,empty);
    record.servedBuildEvidence = `Fresh ${nodeRuntime?"production Node server with real opaque session verification":"Worker"} and isolated proxy started after build hash; authenticated API returned ${empty?"empty Markaz setup":"fixture admin"}; feature behavior checked below.`;
    await test(base,record,{directory,env});
  } finally {
    if(label.startsWith("Task 22"))record.workerLogTail=logs.join("").slice(-4000);
    for(const child of [proxy,worker]) if(child && child.exitCode===null) child.kill("SIGTERM");
    await new Promise(resolve=>setTimeout(resolve,300));
    rmSync(directory,{recursive:true,force:true});
  }
}
async function api(base, persona, body, options={}) {
  const response = await fetch(`${base}${options.path || "/api/app"}`,{method:body?"POST":"GET",headers:{"x-audit-persona":persona,...(body?{"content-type":"application/json"}:{}),...(options.headers||{})},...(body?{body:JSON.stringify(body)}:{})});
  let data;
  try { data=await response.json(); } catch { throw new Error(`Non-JSON API response: HTTP ${response.status}`); }
  return {status:response.status,data,headers:Object.fromEntries(response.headers)};
}
// Generic edits carry the version the actor's read returned. Negative access and
// validation probes still exercise the same payload; a hidden record has no version.
async function versionedEdit(base, persona, body) {
  const state=await api(base,persona);
  const current=state.data.objects?.find(row=>row.id===body.id);
  return api(base,persona,{...body,...(current?{expectedUpdatedAt:current.updatedAt}:{})});
}
function check(record,name,condition,classification="policy-pass",details={}) {
  const pass=Boolean(condition);
  record.checks.push({name,classification,pass,...details});
  if(!pass) throw new Error(`${name}: ${JSON.stringify(details)}`);
}
async function daily() {
  await session("daily",async(base,record)=>{
    for (const jamaatId of ["jamaat-weekend","jamaat-mastooraat"]) {
      const grant=await api(base,"admin",{action:"setMemberPermission",jamaatId,personId:"p-planner",scopes:["roster","route","amaal"]});
      check(record,`explicit planner grant for ${jamaatId}`,grant.status===200,"policy-pass",{status:grant.status});
    }
    const run=command(["audit/daily-mashwara-test.mjs"],{AUDIT_BASE:base});
    check(record,"daily suite 12 groups",run.stdout.includes("12 daily Mashwara prerequisite test groups passed"),"policy-pass",{command:run.command});
  });
}
async function dependencySmoke() {
  await session("dependency-smoke",async(base,record)=>{
    const anonymous=await fetch(`${base}/`,{headers:{"x-audit-persona":"anonymous"},redirect:"manual"});
    check(record,"anonymous page stays protected",anonymous.status!==200,"policy-pass",{status:anonymous.status});
    const page=await fetch(`${base}/`,{headers:{"x-audit-persona":"admin"},redirect:"manual"});
    const html=await page.text();
    check(record,"authenticated page renders My Jamaat",page.status===200&&html.includes("My Jamaat")&&html.includes("<html"),"policy-pass",{status:page.status});
    const saved=await api(base,"ameer",{action:"createItem",kind:"message",parentId:"jamaat-weekend",title:"Task 02 dependency smoke",data:{text:"Synthetic runtime save smoke"}});
    check(record,"API saves synthetic chat",saved.status===200&&Boolean(saved.data.id),"policy-pass",{status:saved.status});
    const member=await api(base,"member");
    check(record,"member reads saved chat",member.status===200&&member.data.objects.some(object=>object.id===saved.data.id&&object.data.text==="Synthetic runtime save smoke"),"policy-pass");
    const rows=await readSheet(path.join(root,"audit/organizer-review-workbook.xlsx"));
    check(record,"XLSX parser reads audit workbook",rows.length===3&&rows[0][0]==="Full Name"&&rows[1][0]==="qa-weekend XLSX يوسف"&&rows[2][0]==="qa-weekend XLSX Name Only","policy-pass",{rows:rows.length});
  });
}
async function authorizationBaseline() {
  await session("authorization-baseline",async(base,record)=>{
    const anonymous=await api(base,"anonymous");
    check(record,"anonymous read denied",anonymous.status===401,"policy-pass",{actual:anonymous.status,expected:401});
    const pendingBefore=await api(base,"pending");
    check(record,"pending starts as worker",pendingBefore.status===200&&pendingBefore.data.me.role==="worker","policy-pass");
    const grant=await api(base,"pending",{action:"setMemberPermission",jamaatId:"jamaat-pending",personId:"p-pending",manage:true,viewContacts:true});
    const known=grant.status===200;
    const classification=known?"known-defect-reproduced":"policy-pass";
    check(record,"AUTH-02 policy outcome",known||grant.status===403,classification,{actual:grant.status,intended:403,finding:"AUTH-02"});
    result.classifications.push({finding:"AUTH-02",kind:classification,actual:grant.status,intended:403});
    const pendingAfter=await api(base,"pending");
    const membership=pendingAfter.data.memberships.find(m=>m.jamaatId==="jamaat-pending"&&m.personId==="p-pending");
    // A pending creator has inherent planning access; denial is proved by the absence
    // of a delegated grant and contact scope, not by the legacy manage display flag.
    check(record,"self-grant state matches response",known ? membership?.permissions?.manage===true&&membership?.permissions?.viewContacts===true : !membership?.permissions?.grant&&!membership?.permissions?.scopes?.includes("contacts")&&membership?.permissions?.viewContacts!==true,classification);
    const planner=await api(base,"planner");
    check(record,"planner fixture available",planner.status===200,"policy-pass",{actual:planner.status});
    const seesIncident=planner.data.objects.some(object=>object.id==="incident-weekend");
    check(record,"AUTH-GAP-01 policy outcome",typeof seesIncident==="boolean",seesIncident?"known-defect-reproduced":"policy-pass",{actual:seesIncident,intended:false,finding:"AUTH-GAP-01"});
    result.classifications.push({finding:"AUTH-GAP-01",kind:seesIncident?"known-defect-reproduced":"policy-pass",actual:seesIncident,intended:false});
    const created=await api(base,"admin",{action:"createJamaat",title:"Task 01 selected Ameer fixture",startAt:"2026-10-02",endAt:"2026-10-04",kind:"regular",ameerId:"p-member"});
    check(record,"selected Ameer setup",created.status===200&&Boolean(created.data.id),"policy-pass",{actual:created.status});
    const admin=await api(base,"admin");
    const hasMembership=admin.data.memberships.some(member=>member.jamaatId===created.data.id&&member.personId==="p-member"&&member.role==="ameer");
    check(record,"AUTH-01 policy outcome",typeof hasMembership==="boolean",hasMembership?"policy-pass":"known-defect-reproduced",{actual:hasMembership,intended:true,finding:"AUTH-01"});
    result.classifications.push({finding:"AUTH-01",kind:hasMembership?"policy-pass":"known-defect-reproduced",actual:hasMembership,intended:true});
  });
}
async function isolation() {
  await session("isolation A",async(base,record)=>{
    const changed=await api(base,"admin",{action:"setMarkazRole",personId:"p-outsider",role:"markaz_ameer"});
    check(record,"admin changes synthetic global role",changed.status===200,"policy-pass",{actual:changed.status});
    const after=await api(base,"outsider");
    check(record,"run A sees its role mutation",after.data.me.role==="markaz_ameer","policy-pass",{actual:after.data.me.role});
  });
  await session("isolation B",async(base,record)=>{
    const fresh=await api(base,"outsider");
    check(record,"run B has original worker role",fresh.status===200&&fresh.data.me.role==="worker","policy-pass",{actual:fresh.data.me?.role});
  });
}
async function validation() {
  await session("validation and legacy review",async(base,record)=>{
    const before=await api(base,"admin");
    check(record,"fixture loaded",before.status===200&&before.data.objects.some(o=>o.id==="jamaat-weekend"));
    const originalCount=before.data.objects.length;
    const invalid=[
      ["null root",null], ["array root",[]],
      ["impossible Jamaat day",{action:"createJamaat",title:"Invalid date",startAt:"2026-02-30",endAt:"2026-03-02"}],
      ["out-of-range calendar day",{action:"createJamaat",title:"Invalid date",startAt:"2026-99-99",endAt:"2026-03-02"}],
      ["nonsense Jamaat date",{action:"createJamaat",title:"Invalid date",startAt:"not-a-date",endAt:"zzzz"}],
      ["reversed offset instants",{action:"createJamaat",title:"Invalid interval",startAt:"2026-10-02T10:00:00-12:00",endAt:"2026-10-02T11:00:00+14:00"}],
      ["unsupported Jamaat type",{action:"createJamaat",title:"Invalid type",startAt:"2026-10-02",endAt:"2026-10-03",kind:"other"}],
      ["privilege field on create",{action:"createJamaat",title:"Mass assignment",startAt:"2026-10-02",endAt:"2026-10-03",ameerStatus:"approved"}],
      ["array money amount",{action:"createItem",kind:"money",parentId:"jamaat-weekend",title:"Invalid money",data:{amountCents:[250],date:"2026-10-02"}}],
      ["boolean money amount",{action:"createItem",kind:"money",parentId:"jamaat-weekend",title:"Invalid money",data:{amountCents:true,date:"2026-10-02"}}],
      ["fractional note count",{action:"createItem",kind:"note",parentId:"jamaat-weekend",title:"Invalid count",data:{text:"A note",peopleTashkiled:1.5}}],
      ["boolean note count",{action:"createItem",kind:"note",parentId:"jamaat-weekend",title:"Invalid count",data:{text:"A note",peopleTashkiled:true}}],
      ["null create data",{action:"createItem",kind:"note",parentId:"jamaat-weekend",title:"Invalid data",data:null}],
      ["wrong-kind event place",{action:"createItem",kind:"event",title:"Invalid place",startAt:"2026-10-02",endAt:"2026-10-03",data:{locationId:"jamaat-weekend"}}],
      ["cross-tenant event place",{action:"createItem",kind:"event",title:"Invalid place",startAt:"2026-10-02",endAt:"2026-10-03",data:{locationId:"place-other"}}],
      ["wrong-kind Mashwara place",{action:"createMashwara",title:"Invalid place",startAt:"2026-10-02T20:00:00Z",locationId:"jamaat-weekend"}],
      ["cross-tenant Mashwara place",{action:"createMashwara",title:"Invalid place",startAt:"2026-10-02T20:00:00Z",locationId:"place-other"}],
      ["invalid edit status",{action:"updateItem",id:"stay-1",status:"teleported"}],
      ["invalid edit host state",{action:"updateItem",id:"stay-1",data:{hostStatus:"teleported"}}],
      ["empty edit host state",{action:"updateItem",id:"stay-1",data:{hostStatus:""}}],
      ["wrong-kind edit location",{action:"updateItem",id:"mashwara-public",data:{locationId:"jamaat-weekend"}}],
      ["cross-tenant edit location",{action:"updateItem",id:"mashwara-public",data:{locationId:"place-other"}}],
      ["invalid edit date",{action:"updateItem",id:"jamaat-weekend",startAt:"2026-02-30"}],
      ["reversed edit interval",{action:"updateItem",id:"jamaat-weekend",startAt:"2026-10-05"}],
      ["invalid edit count",{action:"updateItem",id:"note-weekend",data:{peopleTashkiled:[2]}}],
      ["privilege field on edit",{action:"updateItem",id:"jamaat-weekend",data:{ameerStatus:"approved"}}],
      ["malformed edit data",{action:"updateItem",id:"stay-1",data:[]}],
    ];
    for (const [name,body] of invalid) {
      const response=await fetch(`${base}/api/app`,{method:"POST",headers:{"x-audit-persona":"admin","content-type":"application/json"},body:JSON.stringify(body)});
      const payload=await response.json();
      check(record,name,response.status>=400&&response.status<500&&typeof payload.error==="string","policy-pass",{status:response.status,error:payload.error});
    }
    const malformed=await fetch(`${base}/api/app`,{method:"POST",headers:{"x-audit-persona":"admin","content-type":"application/json"},body:"{"});
    check(record,"malformed JSON",malformed.status===400,"policy-pass",{status:malformed.status});
    const concurrent=await Promise.all(["2026-02-30","2026-02-31"].map(startAt=>api(base,"admin",{action:"createJamaat",title:"Concurrent invalid date",startAt,endAt:"2026-03-02"})));
    check(record,"concurrent invalid writes rejected",concurrent.every(response=>response.status===400),"policy-pass",{statuses:concurrent.map(response=>response.status)});
    const afterInvalid=await api(base,"admin");
    check(record,"invalid create and edit attempts did not write",afterInvalid.data.objects.length===originalCount&&afterInvalid.data.objects.find(o=>o.id==="stay-1").data.hostStatus==="confirmed"&&afterInvalid.data.objects.find(o=>o.id==="mashwara-public").data.locationId==="place-markaz","policy-pass",{before:originalCount,after:afterInvalid.data.objects.length});

    const created=await api(base,"admin",{action:"createJamaat",title:"Validated trip",startAt:"2026-10-06",endAt:"2026-10-08",kind:"regular",selfAmeer:true});
    check(record,"valid Jamaat create",created.status===200&&!!created.data.id,"policy-pass",{status:created.status});
    const stay=await api(base,"admin",{action:"createItem",kind:"stay",parentId:created.data.id,title:"Validated stay",startAt:"2026-10-06",endAt:"2026-10-07",data:{placeId:"place-1",hostStatus:"proposed",conditions:"Host contacted"}});
    check(record,"valid stay create",stay.status===200&&!!stay.data.id,"policy-pass",{status:stay.status});
    const money=await api(base,"admin",{action:"createItem",kind:"money",parentId:created.data.id,title:"Validated collection",idempotencyKey:"task03-validation-money-1",data:{type:"collection",amountCents:1250,date:"2026-10-06",note:"Synthetic"}});
    check(record,"valid money create",money.status===200&&!!money.data.id,"policy-pass",{status:money.status});
    const note=await api(base,"admin",{action:"createItem",kind:"note",parentId:created.data.id,title:"Validated note",data:{text:"Synthetic note",peopleTashkiled:2,jamaatsTashkiled:1}});
    check(record,"valid note create",note.status===200&&!!note.data.id,"policy-pass",{status:note.status});
    const mashwara=await api(base,"admin",{action:"createMashwara",title:"Validated Mashwara",startAt:"2026-10-06T20:00:00.000Z",type:"general",recurrence:"none",ameerId:"p-admin",locationId:"place-1",visibility:"markaz",details:"Synthetic"});
    check(record,"valid Mashwara create",mashwara.status===200&&!!mashwara.data.id,"policy-pass",{status:mashwara.status});
    const edit=await api(base,"admin",routePayload((await api(base,"admin")).data.objects,stay.data.id,{title:"Validated stay updated",hostStatus:"confirmed",conditions:"Ready"}));
    check(record,"valid stay edit",edit.status===200,"policy-pass",{status:edit.status});
    const editAgain=await api(base,"admin",routePayload((await api(base,"admin")).data.objects,stay.data.id,{title:"Validated stay updated",hostStatus:"confirmed",conditions:"Ready"}));
    check(record,"valid edit retry",editAgain.status===200,"policy-pass",{status:editAgain.status});
    const messageTitle=await versionedEdit(base,"admin",{action:"updateItem",id:"message-weekend",title:"Updated synthetic chat title"});
    check(record,"existing message title edit remains valid",messageTitle.status===200,"policy-pass",{status:messageTitle.status});
    const denied=await versionedEdit(base,"member",{action:"updateItem",id:stay.data.id,data:{hostStatus:"arrived"}});
    check(record,"ordinary member edit denied",denied.status===403,"policy-pass",{status:denied.status});
    const state=await api(base,"admin");
    check(record,"valid write readback",state.data.objects.some(o=>o.id===stay.data.id&&o.data.hostStatus==="confirmed"&&o.data.conditions==="Ready")&&state.data.objects.some(o=>o.id===money.data.id&&o.data.amountCents===1250)&&state.data.objects.some(o=>o.id===note.data.id&&o.data.peopleTashkiled===2),"policy-pass");

    const objects=new Map(state.data.objects.map(o=>[o.id,o]));
    const report={scope:"Disposable synthetic D1 fixture only; production records were not accessed.",mode:"Read-only inventory after seeding deliberately invalid legacy rows; no repair or deletion performed.",buildHash,records:[]};
    for (const id of ["legacy-invalid-date","legacy-invalid-money","legacy-invalid-ref"]) {
      const item=objects.get(id);
      const findings=[];
      if (id==="legacy-invalid-date") findings.push("Impossible calendar start date; verify original travel plan before correction.");
      if (id==="legacy-invalid-money") findings.push("Boolean amountCents; reconcile against original receipt before correction.");
      if (id==="legacy-invalid-ref") findings.push(`locationId references ${objects.get(item.data.locationId)?.kind||"missing"}; confirm intended place before correction.`);
      report.records.push({id,kind:item.kind,findings,disposition:"manual review required; retain record and audit history"});
    }
    const reportPath=(nodeRuntime?path.join(path.dirname(output),"render-task-03-historical-review.json"):path.join(root,"audit/repair-task-03-historical-review.json"));
    writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n");
    check(record,"historical invalid records inventoried without deletion",report.records.length===3&&report.records.every(row=>row.findings.length&&objects.has(row.id)),"policy-pass",{report:reportPath,ids:report.records.map(row=>row.id)});
  },"audit/repair-task-03-legacy-fixture.sql");
  await session("validation from empty database",async(base,record)=>{
    const setup=await api(base,"new");
    check(record,"empty database offers setup",setup.status===200&&setup.data.setup==="create-markaz","policy-pass");
    const invalid=await api(base,"new",{action:"createMarkaz",name:"",yourName:"Synthetic admin"});
    check(record,"empty setup rejects missing name",invalid.status===400,"policy-pass",{status:invalid.status});
    const created=await api(base,"new",{action:"createMarkaz",name:"Synthetic empty Markaz",yourName:"Synthetic admin"});
    check(record,"empty setup creates Markaz",created.status===200,"policy-pass",{status:created.status});
    const state=await api(base,"new");
    check(record,"empty setup readback",state.status===200&&state.data.setup==="ready"&&state.data.me?.name==="Synthetic admin"&&state.data.objects.length===0,"policy-pass");
    const contactless=await api(base,"new",{action:"addPerson",name:"Contactless synthetic member"});
    check(record,"optional contact details remain valid",contactless.status===200&&!!contactless.data.id,"policy-pass",{status:contactless.status});
    const jamaat=await api(base,"new",{action:"createJamaat",title:"First valid Jamaat",startAt:"2026-10-02",endAt:"2026-10-03",kind:"regular",selfAmeer:true});
    check(record,"first valid Jamaat from empty database",jamaat.status===200&&!!jamaat.data.id,"policy-pass",{status:jamaat.status});
    const readback=await api(base,"new");
    check(record,"first Jamaat retained",readback.data.objects.some(object=>object.id===jamaat.data.id&&object.startAt==="2026-10-02"),"policy-pass");
  },undefined,true);
}
async function ameer() {
  await session("ameer lifecycle on existing records",async(base,record)=>{
    const adminBefore=await api(base,"admin"), pendingBefore=await api(base,"pending");
    const pendingMember=pendingBefore.data.memberships.find(m=>m.jamaatId==="jamaat-pending"&&m.personId==="p-pending");
    check(record,"migration demotes stray pending Ameer role",pendingMember?.role==="member","policy-pass",{role:pendingMember?.role});
    check(record,"legacy self-grant is quarantined",pendingMember?.permissions.scopes?.join(",")==="roster,route,amaal"&&pendingMember?.permissions.viewContacts===false&&pendingMember?.permissions.needsReview===true&&!pendingMember?.permissions.grant,"policy-pass",{permissions:pendingMember?.permissions});
    check(record,"legacy self-grant does not expose contact",pendingBefore.data.people.find(p=>p.id==="p-member")?.phone===null,"policy-pass");
    check(record,"migration supplies missing approved membership",adminBefore.data.memberships.some(m=>m.jamaatId==="legacy-approved-missing-member"&&m.personId==="p-member"&&m.role==="ameer"),"policy-pass");
    check(record,"cross-tenant legacy Ameer stays unresolved",!adminBefore.data.memberships.some(m=>m.jamaatId==="legacy-cross-tenant-ameer"&&m.personId==="p-other-admin"),"policy-pass");
    const ambiguousGrants=adminBefore.data.memberships.filter(m=>m.permissions.needsReview).map(m=>({jamaatId:m.jamaatId,personId:m.personId,reason:"Legacy manage/contact grant lacks trusted provenance. Contact and sensitive access are quarantined pending Task 05 review."}));
    const report={scope:"Disposable synthetic existing-record fixture; production records were not accessed.",buildHash,unresolved:[{jamaatId:"legacy-cross-tenant-ameer",reason:"Approved Ameer points to a person in another Markaz; choose the correct local person before correction."},...ambiguousGrants],deterministicRepair:[{jamaatId:"legacy-approved-missing-member",personId:"p-member",change:"Forward migration inserted missing approved Ameer membership."},{jamaatId:"jamaat-pending",personId:"p-pending",change:"Forward migration demoted a pending creator's stale Ameer role."}]};
    const reportPath=(nodeRuntime?path.join(path.dirname(output),"render-task-04-historical-review.json"):path.join(root,"audit/repair-task-04-historical-review.json"));
    writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n");
    check(record,"ambiguous legacy authority has explicit review report",report.unresolved.length>=4&&report.deterministicRepair.length===2,"policy-pass",{report:reportPath,unresolved:report.unresolved.length});

    const selfGrant=await api(base,"pending",{action:"setMemberPermission",jamaatId:"jamaat-pending",personId:"p-pending",manage:true,viewContacts:true});
    check(record,"pending creator cannot self-grant",selfGrant.status===403,"policy-pass",{status:selfGrant.status});
    const otherGrant=await api(base,"pending",{action:"setMemberPermission",jamaatId:"jamaat-pending",personId:"p-member",manage:true,viewContacts:true});
    check(record,"pending creator cannot grant another member",otherGrant.status===403,"policy-pass",{status:otherGrant.status});
    const route=await versionedEdit(base,"pending",{action:"updateItem",id:"jamaat-pending",data:{route:"Task 04 pending safe route"}});
    check(record,"pending creator can edit safe route",route.status===200,"policy-pass",{status:route.status});
    const names=await api(base,"pending",undefined,{path:"/api/app?candidateJamaatId=jamaat-pending&q=Abdul"});
    check(record,"pending creator finds bounded name-only existing candidate",names.status===200&&names.data.candidates?.some(p=>p.id==="p-ameer"&&p.name)&&names.data.candidates.length<=10&&names.data.candidates.every(p=>Object.keys(p).sort().join(",")==="id,name"),"policy-pass",{status:names.status,candidates:names.data.candidates});
    const shortSearch=await api(base,"pending",undefined,{path:"/api/app?candidateJamaatId=jamaat-pending&q=A"});
    check(record,"candidate search requires a meaningful query",shortSearch.status===400,"policy-pass",{status:shortSearch.status});
    const deniedSearch=await api(base,"member",undefined,{path:"/api/app?candidateJamaatId=jamaat-pending&q=Abdul"});
    check(record,"other member cannot search draft candidates",deniedSearch.status===403,"policy-pass",{status:deniedSearch.status});
    const addExisting=await api(base,"pending",{action:"addMember",jamaatId:"jamaat-pending",personId:"p-ameer"});
    check(record,"pending creator can add an existing Markaz person",addExisting.status===200&&(await api(base,"pending")).data.memberships.some(m=>m.jamaatId==="jamaat-pending"&&m.personId==="p-ameer"),"policy-pass",{status:addExisting.status});
    const stay=await api(base,"pending",{action:"createItem",kind:"stay",parentId:"jamaat-pending",title:"Task 04 draft stay",startAt:"2026-10-02",endAt:"2026-10-03",data:{placeId:"place-1",hostStatus:"proposed"}});
    check(record,"pending creator can plan stay",stay.status===200&&!!stay.data.id,"policy-pass",{status:stay.status});
    const sensitive=await api(base,"pending",{action:"createItem",kind:"money",parentId:"jamaat-pending",title:"Denied draft collection",data:{amountCents:250,date:"2026-10-02"}});
    check(record,"pending self-grant cannot write sensitive Baraka",sensitive.status===403,"policy-pass",{status:sensitive.status});
    const daily=await api(base,"pending",{action:"createDailyMashwara",jamaatId:"jamaat-pending",date:"2026-10-02",ameerId:"p-pending"});
    check(record,"pending creator can plan separate daily Mashwara",daily.status===200&&!!daily.data.id,"policy-pass",{status:daily.status});

    const decline=await api(base,"admin",{action:"declineAmeer",jamaatId:"jamaat-pending"});
    check(record,"leader declines pending request",decline.status===200,"policy-pass",{status:decline.status});
    const declineRetry=await api(base,"admin",{action:"declineAmeer",jamaatId:"jamaat-pending"});
    check(record,"decline retry is idempotent",declineRetry.status===200&&declineRetry.data.existing===true,"policy-pass",{status:declineRetry.status});
    const afterDecline=await api(base,"pending");
    check(record,"declined state is explicit",afterDecline.data.objects.find(o=>o.id==="jamaat-pending")?.data.ameerStatus==="declined","policy-pass");
    check(record,"declined creator retains safe route planning",(await versionedEdit(base,"pending",{action:"updateItem",id:"jamaat-pending",data:{route:"Task 04 declined draft route"}})).status===200,"policy-pass");
    check(record,"declined creator still cannot grant",(await api(base,"pending",{action:"setMemberPermission",jamaatId:"jamaat-pending",personId:"p-pending",manage:true,viewContacts:true})).status===403,"policy-pass");
    const revoked=afterDecline.data.memberships.find(m=>m.jamaatId==="jamaat-pending"&&m.personId==="p-pending")?.permissions;
    check(record,"decline removes unverified stored grant",revoked?.viewContacts===false&&revoked?.review==="legacy-unverified-grant-revoked"&&revoked?.needsReview===false&&!revoked?.grant,"policy-pass",{permissions:revoked});
    const requestAgain=await api(base,"pending",{action:"requestAmeer",jamaatId:"jamaat-pending"});
    check(record,"declined creator can request review again",requestAgain.status===200,"policy-pass",{status:requestAgain.status});
    const requestRetry=await api(base,"pending",{action:"requestAmeer",jamaatId:"jamaat-pending"});
    check(record,"request retry is idempotent",requestRetry.status===200&&requestRetry.data.existing===true,"policy-pass",{status:requestRetry.status});

    const appointment=await api(base,"admin",{action:"appointAmeer",jamaatId:"jamaat-pending",personId:"p-member"});
    check(record,"leader substitutes approved Ameer",appointment.status===200,"policy-pass",{status:appointment.status});
    const state=await api(base,"admin"), jamaat=state.data.objects.find(o=>o.id==="jamaat-pending");
    const roles=state.data.memberships.filter(m=>m.jamaatId==="jamaat-pending"&&m.role==="ameer");
    check(record,"exactly one matching Ameer membership after substitution",jamaat?.data.ameerId==="p-member"&&jamaat?.data.ameerStatus==="approved"&&roles.length===1&&roles[0].personId==="p-member","policy-pass",{roles:roles.map(m=>m.personId)});
    check(record,"former pending creator loses route authority immediately",(await versionedEdit(base,"pending",{action:"updateItem",id:"jamaat-pending",data:{route:"FORBIDDEN"}})).status===403,"policy-pass");
    check(record,"former pending creator loses grant authority immediately",(await api(base,"pending",{action:"setMemberPermission",jamaatId:"jamaat-pending",personId:"p-pending",manage:true,viewContacts:true})).status===403,"policy-pass");
    check(record,"former pending creator loses draft candidate lookup immediately",(await api(base,"pending",undefined,{path:"/api/app?candidateJamaatId=jamaat-pending&q=Abdul"})).status===403,"policy-pass");
    const pendingAfter=await api(base,"pending");
    check(record,"former creator sees no protected contact or sensitive note",pendingAfter.data.people.find(p=>p.id==="p-member")?.phone===null&&!pendingAfter.data.objects.some(o=>o.id==="incident-weekend"),"policy-pass");
    const separateMashwara=await api(base,"pending",{action:"setDailyAmal",umoorId:`${daily.data.id}:amal:0`,active:true,personIds:["p-pending"],notes:"Separate Mashwara role remains"});
    check(record,"daily Mashwara Ameer remains a separate scoped role",separateMashwara.status===200,"policy-pass",{status:separateMashwara.status});
    const approvedDaily=await api(base,"member",{action:"createDailyMashwara",jamaatId:"jamaat-pending",date:"2026-10-03",ameerId:"p-member"});
    check(record,"approved Ameer is eligible to lead daily Mashwara",approvedDaily.status===200,"policy-pass",{status:approvedDaily.status});
    const noReRequest=await api(base,"pending",{action:"requestAmeer",jamaatId:"jamaat-pending"});
    check(record,"former creator cannot reopen approved appointment",noReRequest.status===400,"policy-pass",{status:noReRequest.status});

    const independent=await api(base,"admin",{action:"setMemberPermission",jamaatId:"jamaat-pending",personId:"p-pending",manage:true,viewContacts:true,labels:"Route planner"});
    check(record,"leader can issue provenance-backed independent grant",independent.status===200,"policy-pass",{status:independent.status});
    const independentState=await api(base,"pending");
    check(record,"independent contact grant works",independentState.data.people.find(p=>p.id==="p-member")?.phone!==null,"policy-pass");
    const replace=await api(base,"admin",{action:"appointAmeer",jamaatId:"jamaat-pending",personId:"p-contacts"});
    check(record,"leader can replace approved Ameer",replace.status===200,"policy-pass",{status:replace.status});
    const afterReplace=await api(base,"admin"), newRoles=afterReplace.data.memberships.filter(m=>m.jamaatId==="jamaat-pending"&&m.role==="ameer");
    check(record,"replacement adds person as member and demotes predecessor",newRoles.length===1&&newRoles[0].personId==="p-contacts"&&afterReplace.data.objects.find(o=>o.id==="jamaat-pending")?.data.ameerId==="p-contacts"&&afterReplace.data.memberships.some(m=>m.jamaatId==="jamaat-pending"&&m.personId==="p-member"&&m.role==="member"),"policy-pass",{roles:newRoles.map(m=>m.personId)});
    check(record,"independent leader grant survives replacement",(await api(base,"pending")).data.memberships.some(m=>m.jamaatId==="jamaat-pending"&&m.personId==="p-pending"&&m.permissions.manage===true&&m.permissions.viewContacts===true),"policy-pass");
    check(record,"former approved Ameer loses route authority",(await versionedEdit(base,"member",{action:"updateItem",id:"jamaat-pending",data:{route:"FORBIDDEN"}})).status===403,"policy-pass");
    check(record,"former approved Ameer cannot revoke a current member's grant",(await api(base,"member",{action:"revokeMemberPermissions",jamaatId:"jamaat-pending",personId:"p-pending"})).status===403,"policy-pass");
    check(record,"former approved Ameer loses contact access",(await api(base,"member")).data.people.find(p=>p.id==="p-contacts")?.phone===null,"policy-pass");

    const selectedCreate=await api(base,"admin",{action:"createJamaat",title:"Task 04 selected Ameer",startAt:"2026-10-02",endAt:"2026-10-04",kind:"regular",ameerId:"p-outsider"});
    check(record,"direct creation with another approved Ameer",selectedCreate.status===200&&!!selectedCreate.data.id,"policy-pass",{status:selectedCreate.status});
    const createdState=await api(base,"admin"), createdRoles=createdState.data.memberships.filter(m=>m.jamaatId===selectedCreate.data.id&&m.role==="ameer");
    check(record,"selected Ameer is member exactly once",createdRoles.length===1&&createdRoles[0].personId==="p-outsider"&&createdState.data.memberships.some(m=>m.jamaatId===selectedCreate.data.id&&m.personId==="p-admin"&&m.role==="member"),"policy-pass",{roles:createdRoles.map(m=>m.personId)});
    check(record,"selected Ameer can create daily Mashwara",(await api(base,"outsider",{action:"createDailyMashwara",jamaatId:selectedCreate.data.id,date:"2026-10-02",ameerId:"p-outsider"})).status===200,"policy-pass");
    check(record,"cross-Markaz appointment denied",(await api(base,"other-admin",{action:"appointAmeer",jamaatId:"jamaat-pending",personId:"p-other-admin"})).status===404,"policy-pass");
    check(record,"wrong-tenant selected person denied",(await api(base,"admin",{action:"appointAmeer",jamaatId:"jamaat-pending",personId:"p-other-admin"})).status===400,"policy-pass");
    check(record,"nonleader appointment denied",(await api(base,"pending",{action:"appointAmeer",jamaatId:"jamaat-pending",personId:"p-pending"})).status===403,"policy-pass");
    check(record,"approved Ameer cannot self-grant",(await api(base,"contacts",{action:"setMemberPermission",jamaatId:"jamaat-pending",personId:"p-contacts",manage:true,viewContacts:true})).status===403,"policy-pass");
    const decisions=(await api(base,"admin")).data.ameerDecisions.filter(d=>d.jamaatId==="jamaat-pending");
    check(record,"decision history records decline and replacement",decisions.some(d=>d.action==="declined"&&d.subjectId==="p-pending")&&decisions.some(d=>d.action==="replaced"&&d.subjectId==="p-contacts"&&d.previousAmeerId==="p-member"),"policy-pass",{decisions});
  },"audit/repair-task-04-legacy-fixture.sql");

  await session("concurrent Ameer replacement",async(base,record)=>{
    const created=await api(base,"admin",{action:"createJamaat",title:"Task 04 race",startAt:"2026-10-02",endAt:"2026-10-04",selfAmeer:true});
    check(record,"race Jamaat created",created.status===200&&!!created.data.id,"policy-pass",{status:created.status});
    const candidates=["p-member","p-contacts","p-outsider"];
    const attempts=await Promise.all(candidates.map(personId=>api(base,"admin",{action:"appointAmeer",jamaatId:created.data.id,personId})));
    check(record,"concurrent appointments complete",attempts.every(response=>response.status===200),"policy-pass",{statuses:attempts.map(response=>response.status)});
    const state=await api(base,"admin"), jamaat=state.data.objects.find(o=>o.id===created.data.id), roles=state.data.memberships.filter(m=>m.jamaatId===created.data.id&&m.role==="ameer");
    check(record,"concurrent final state has one matching Ameer",jamaat?.data.ameerStatus==="approved"&&roles.length===1&&roles[0].personId===jamaat.data.ameerId,"policy-pass",{data:jamaat?.data,roles:roles.map(m=>m.personId)});
    const retry=await api(base,"admin",{action:"appointAmeer",jamaatId:created.data.id,personId:jamaat.data.ameerId});
    const after=await api(base,"admin");
    check(record,"appointment retry preserves single membership",retry.status===200&&after.data.memberships.filter(m=>m.jamaatId===created.data.id&&m.role==="ameer").length===1,"policy-pass",{status:retry.status});
  });

  await session("Ameer lifecycle from empty database",async(base,record)=>{
    check(record,"empty database is ready for Markaz setup",(await api(base,"new")).data.setup==="create-markaz","policy-pass");
    check(record,"empty Markaz setup",(await api(base,"new",{action:"createMarkaz",name:"Task 04 empty Markaz",yourName:"Task 04 admin"})).status===200,"policy-pass");
    const created=await api(base,"new",{action:"createJamaat",title:"Task 04 first draft",startAt:"2026-10-02",endAt:"2026-10-04",selfAmeer:true});
    check(record,"first draft starts pending with creator member",created.status===200&&created.data.ameerStatus==="pending"&&(await api(base,"new")).data.memberships.some(m=>m.jamaatId===created.data.id&&m.role==="member"),"policy-pass",{status:created.status});
    const approved=await api(base,"new",{action:"appointAmeer",jamaatId:created.data.id,personId:(await api(base,"new")).data.me.id});
    const state=await api(base,"new");
    check(record,"first draft approval has one member Ameer",approved.status===200&&state.data.memberships.filter(m=>m.jamaatId===created.data.id&&m.role==="ameer").length===1,"policy-pass",{status:approved.status});
  },undefined,true);
}
async function permissions() {
  await session("Task 05 permission matrix",async(base,record)=>{
    const plannerBefore=await api(base,"planner");
    check(record,"unproven legacy planner grant is inactive",!plannerBefore.data.memberships.find(m=>m.jamaatId==="jamaat-weekend"&&m.personId==="p-planner")?.permissions.scopes.length,"policy-pass");
    check(record,"legacy planner cannot edit route",(await versionedEdit(base,"planner",{action:"updateItem",id:"jamaat-weekend",data:{route:"FORBIDDEN"}})).status===403,"policy-pass");
    const grant=await api(base,"admin",{action:"setMemberPermission",jamaatId:"jamaat-weekend",personId:"p-planner",scopes:["roster","route","amaal"],labels:"Route planner"});
    check(record,"leader grants only three planning scopes",grant.status===200,"policy-pass",{status:grant.status});
    const planner=await api(base,"planner");
    const scopes=planner.data.memberships.find(m=>m.jamaatId==="jamaat-weekend"&&m.personId==="p-planner")?.permissions.scopes;
    check(record,"planning scopes are explicit",["roster","route","amaal"].every(s=>scopes.includes(s))&&scopes.length===3,"policy-pass",{scopes});
    check(record,"planner edits route",(await versionedEdit(base,"planner",{action:"updateItem",id:"jamaat-weekend",data:{route:"Scoped route"}})).status===200,"policy-pass");
    check(record,"planner adds existing roster member",(await api(base,"planner",{action:"addMember",jamaatId:"jamaat-weekend",personId:"p-outsider"})).status===200,"policy-pass");
    check(record,"planner can add a‘maal",(await api(base,"planner",{action:"createItem",kind:"assignment",parentId:"jamaat-weekend",title:"Scoped Fajr",data:{amal:"Fajr Bayaan",date:"2026-10-02",personId:"p-outsider"}})).status===200,"policy-pass");
    for (const [name,kind,data] of [["funds","money",{type:"collection",amountCents:100,date:"2026-10-02"}],["notes","note",{text:"FORBIDDEN"}],["tashkil","tashkil",{context:"Jawla",intention:"FORBIDDEN"}],["incidents","incident",{severity:"low",description:"FORBIDDEN"}]]) {
      const attempt=await api(base,"planner",{action:"createItem",kind,parentId:"jamaat-weekend",title:"Forbidden",data});
      check(record,`planning scope does not grant ${name}`,attempt.status===403,"policy-pass",{status:attempt.status});
    }
    const after=await api(base,"planner");
    check(record,"planner sees no protected records or another member contact",!["money","note","tashkil","incident","masjid_note"].some(kind=>after.data.objects.some(o=>o.kind===kind))&&after.data.people.find(p=>p.id==="p-member")?.phone===null,"policy-pass");
    check(record,"delegated planner cannot grant authority",(await api(base,"planner",{action:"setMemberPermission",jamaatId:"jamaat-weekend",personId:"p-member",scopes:["incidents"]})).status===403,"policy-pass");
    check(record,"invalid scope rejected",(await api(base,"admin",{action:"setMemberPermission",jamaatId:"jamaat-weekend",personId:"p-member",scopes:["administrator"]})).status===400,"policy-pass");
    check(record,"cross-Markaz grant denied",(await api(base,"other-admin",{action:"setMemberPermission",jamaatId:"jamaat-weekend",personId:"p-planner",scopes:["funds"]})).status===404,"policy-pass");
    check(record,"contact-only grant",(await api(base,"admin",{action:"setMemberPermission",jamaatId:"jamaat-weekend",personId:"p-contacts",scopes:["contacts"]})).status===200,"policy-pass");
    const contact=await api(base,"contacts");
    check(record,"contact scope reveals member contact only",contact.data.people.find(p=>p.id==="p-member")?.phone!==null&&!contact.data.objects.some(o=>["money","note","tashkil","incident"].includes(o.kind)),"policy-pass");
    check(record,"contact-only user cannot edit route",(await versionedEdit(base,"contacts",{action:"updateItem",id:"jamaat-weekend",data:{route:"FORBIDDEN"}})).status===403,"policy-pass");
    check(record,"leader grants incident-only scope",(await api(base,"admin",{action:"setMemberPermission",jamaatId:"jamaat-weekend",personId:"p-member",scopes:["incidents"]})).status===200,"policy-pass");
    const incidentViewer=await api(base,"member");
    check(record,"incident-only sees incident but not finance or notes",incidentViewer.data.objects.some(o=>o.id==="incident-weekend")&&!incidentViewer.data.objects.some(o=>["money","note","tashkil"].includes(o.kind)),"policy-pass");
    check(record,"incident-only can report",(await api(base,"member",{action:"createItem",kind:"incident",parentId:"jamaat-weekend",title:"Scoped report",data:{severity:"low",description:"Synthetic"}})).status===200,"policy-pass");
  });
}
async function revocation() {
  await session("Task 05 revocation and legacy review",async(base,record)=>{
    const admin=await api(base,"admin");
    const reviews=admin.data.repairReviews;
    check(record,"migration exposes leader-only review queue",reviews.some(r=>r.kind==="legacy-grant")&&reviews.some(r=>r.targetId==="legacy-invalid-assignment"&&r.kind==="invalid-assignment")&&reviews.some(r=>r.targetId==="legacy-invalid-daily-amal"&&r.kind==="invalid-daily-plan")&&reviews.some(r=>r.targetId==="daily-legacy-invalid"&&r.kind==="invalid-daily-ameer"),"policy-pass",{kinds:[...new Set(reviews.map(r=>r.kind))]});
    check(record,"member does not receive review evidence",(await api(base,"member")).data.repairReviews.length===0,"policy-pass");
    const legacy=admin.data.objects.find(o=>o.id==="legacy-invalid-assignment"),plan=admin.data.objects.find(o=>o.id==="legacy-invalid-daily-amal"),daily=admin.data.objects.find(o=>o.id==="daily-legacy-invalid");
    check(record,"unsafe legacy assignment remains attributed but inactive",legacy?.data.personId===null&&legacy.status==="unassigned"&&reviews.find(r=>r.targetId===legacy.id)?.original.includes("p-other-admin"),"policy-pass");
    check(record,"unsafe daily plan keeps valid member only",JSON.stringify(plan?.data.personIds)==='["p-member"]'&&reviews.find(r=>r.targetId===plan.id)?.original.includes("p-other-admin"),"policy-pass",{personIds:plan?.data.personIds});
    check(record,"unsafe daily Ameer cleared for review",daily?.data.ameerId===null&&reviews.find(r=>r.targetId===daily.id)?.original.includes("p-other-admin"),"policy-pass");
    const report={scope:"Disposable synthetic fixture; production records were not inspected or changed.",buildHash,reviewQueue:reviews.map(r=>({kind:r.kind,targetId:r.targetId,status:r.status,originalPreserved:typeof r.original==="string"&&r.original.length>0})),policy:"Unverified grants and invalid live assignments are quarantined. A Markaz leader must verify original evidence and explicitly grant a scope or reassign a current member."};
    writeFileSync((nodeRuntime?path.join(path.dirname(output),"render-task-05-historical-review.json"):path.join(root,"audit/repair-task-05-historical-review.json")),JSON.stringify(report,null,2)+"\n");
    const granted=await api(base,"admin",{action:"setMemberPermission",jamaatId:"jamaat-weekend",personId:"p-planner",scopes:["route","contacts"]});
    check(record,"scoped grant for revocation setup",granted.status===200,"policy-pass",{status:granted.status});
    check(record,"planner route works before revocation",(await versionedEdit(base,"planner",{action:"updateItem",id:"jamaat-weekend",data:{route:"Before revoke"}})).status===200,"policy-pass");
    check(record,"permission revocation succeeds",(await api(base,"admin",{action:"revokeMemberPermissions",jamaatId:"jamaat-weekend",personId:"p-planner"})).status===200,"policy-pass");
    const afterRevoke=await api(base,"planner");
    check(record,"old session loses route and contacts immediately",afterRevoke.data.memberships.find(m=>m.jamaatId==="jamaat-weekend"&&m.personId==="p-planner")?.permissions.scopes.length===0&&afterRevoke.data.people.find(p=>p.id==="p-member")?.phone===null&&(await versionedEdit(base,"planner",{action:"updateItem",id:"jamaat-weekend",data:{route:"FORBIDDEN"}})).status===403,"policy-pass");
    check(record,"delegated planner cannot revoke others",(await api(base,"planner",{action:"revokeMemberPermissions",jamaatId:"jamaat-weekend",personId:"p-member"})).status===403,"policy-pass");
    check(record,"sole Ameer removal blocked",(await api(base,"admin",{action:"removeMember",jamaatId:"jamaat-weekend",personId:"p-ameer"})).status===409,"policy-pass");
    check(record,"new assignment rejects a person outside the Jamaat",(await api(base,"admin",{action:"createItem",kind:"assignment",parentId:"jamaat-weekend",title:"Invalid assignee",data:{amal:"Fajr Bayaan",personId:"p-outsider",date:"2026-10-03"}})).status===400,"policy-pass");
    const memberDaily=await api(base,"admin",{action:"createDailyMashwara",jamaatId:"jamaat-weekend",date:"2026-10-03",ameerId:"p-member"});
    check(record,"daily Mashwara assigned to member",memberDaily.status===200,"policy-pass",{status:memberDaily.status});
    const memberPlan=await api(base,"admin",{action:"setDailyAmal",umoorId:`${memberDaily.data.id}:amal:0`,active:true,personIds:["p-member"],notes:"Before removal"});
    check(record,"daily assignment setup",memberPlan.status===200,"policy-pass",{status:memberPlan.status});
    check(record,"member removal succeeds",(await api(base,"admin",{action:"removeMember",jamaatId:"jamaat-weekend",personId:"p-member"})).status===200,"policy-pass");
    const after=await api(base,"admin"),former=await api(base,"member");
    check(record,"former member loses Jamaat and private daily view",!former.data.objects.some(o=>o.id==="jamaat-weekend"||o.id===memberDaily.data.id||o.id==="incident-weekend"),"policy-pass");
    check(record,"membership removed and historical assignment retained",!after.data.memberships.some(m=>m.jamaatId==="jamaat-weekend"&&m.personId==="p-member")&&after.data.objects.some(o=>o.id==="assignment-khidmah-1"&&o.status==="unassigned"&&o.data.personId===null&&o.data.removedAssigneeId==="p-member"),"policy-pass");
    const activePlan=after.data.objects.find(o=>o.id===`${memberDaily.data.id}:amal:0`),updatedDaily=after.data.objects.find(o=>o.id===memberDaily.data.id);
    check(record,"daily live assignments and Ameer role deactivated with attribution",activePlan?.data.personIds.length===0&&activePlan?.data.removedPersonIds.includes("p-member")&&updatedDaily?.data.ameerId===null&&updatedDaily?.data.formerDailyAmeerId==="p-member","policy-pass",{plan:activePlan?.data,daily:updatedDaily?.data});
    check(record,"former member direct route edit denied",(await versionedEdit(base,"member",{action:"updateItem",id:"jamaat-weekend",data:{route:"FORBIDDEN"}})).status===403,"policy-pass");
    check(record,"removed person cannot be reassigned into the live plan",(await versionedEdit(base,"admin",{action:"updateItem",id:"assignment-khidmah-1",data:{personId:"p-member"}})).status===400,"policy-pass");
    check(record,"cross-Markaz removal denied",(await api(base,"other-admin",{action:"removeMember",jamaatId:"jamaat-weekend",personId:"p-planner"})).status===404,"policy-pass");
    check(record,"repeated removal returns controlled 404",(await api(base,"admin",{action:"removeMember",jamaatId:"jamaat-weekend",personId:"p-member"})).status===404,"policy-pass");
  },"audit/repair-task-05-legacy-fixture.sql");
}
async function resolution() {
  await session("Task 05 names and candidate discovery",async(base,record)=>{
    const member=await api(base,"member");
    const names=new Map(member.data.people.map(p=>[p.id,p]));
    check(record,"Jamaat member resolves related Mashwara and event names",["p-ameer","p-mashwara-ameer","p-team-ameer","p-duty-member"].every(id=>names.has(id)),"policy-pass",{ids:[...names.keys()]});
    check(record,"unrelated Markaz person absent from ordinary directory",!names.has("p-outsider"),"policy-pass");
    check(record,"relationship names do not reveal contacts or affiliation",["p-mashwara-ameer","p-team-ameer","p-duty-member"].every(id=>names.get(id).phone===null&&names.get(id).email===null&&names.get(id).localMasjidId===null),"policy-pass");
    const privateViewer=await api(base,"collaborator");
    check(record,"private Mashwara collaborator resolves Ameer and opinion names",privateViewer.data.objects.some(o=>o.id==="mashwara-private")&&privateViewer.data.people.some(p=>p.id==="p-mashwara-ameer"&&p.phone===null),"policy-pass");
    const denied=await api(base,"member",undefined,{path:"/api/app?candidateParentId=jamaat-weekend&q=Khalid"});
    check(record,"ordinary member cannot search roster candidates",denied.status===403,"policy-pass",{status:denied.status});
    const inaccessible=await api(base,"other-admin",undefined,{path:"/api/app?candidateParentId=jamaat-weekend&q=Khalid"});
    check(record,"other Markaz cannot discover candidates",inaccessible.status===404,"policy-pass",{status:inaccessible.status});
    const grant=await api(base,"admin",{action:"setMemberPermission",jamaatId:"jamaat-weekend",personId:"p-planner",scopes:["roster"]});
    check(record,"roster planner grant",grant.status===200,"policy-pass",{status:grant.status});
    const found=await api(base,"planner",undefined,{path:"/api/app?candidateParentId=jamaat-weekend&q=Khalid"});
    check(record,"planner sees bounded name-only candidate",found.status===200&&found.data.candidates.length===1&&found.data.candidates[0].id==="p-outsider"&&Object.keys(found.data.candidates[0]).sort().join(",")==="id,name","policy-pass",{candidates:found.data.candidates});
    check(record,"planner adds candidate to Jamaat",(await api(base,"planner",{action:"addMember",jamaatId:"jamaat-weekend",personId:"p-outsider"})).status===200,"policy-pass");
    const after=await api(base,"planner",undefined,{path:"/api/app?candidateParentId=jamaat-weekend&q=Khalid"});
    check(record,"current Jamaat member excluded from candidate results",after.status===200&&after.data.candidates.length===0,"policy-pass",{candidates:after.data.candidates});
    const meetingCandidates=await api(base,"collaborator",undefined,{path:"/api/app?candidateParentId=mashwara-private&q=Khalid"});
    check(record,"Mashwara planner finds name-only collaborator candidate",meetingCandidates.status===200&&meetingCandidates.data.candidates.some(p=>p.id==="p-outsider"&&Object.keys(p).length===2),"policy-pass",{candidates:meetingCandidates.data.candidates});
    check(record,"Mashwara planner invites existing candidate into private plan",(await api(base,"collaborator",{action:"addCollaborator",mashwaraId:"mashwara-private",personId:"p-outsider"})).status===200,"policy-pass");
    const newCollaborator=await api(base,"outsider");
    check(record,"invited planner can resolve private plan without contacts",newCollaborator.data.objects.some(o=>o.id==="mashwara-private")&&newCollaborator.data.people.find(p=>p.id==="p-mashwara-ameer")?.phone===null,"policy-pass");
    const eventCandidates=await api(base,"admin",undefined,{path:"/api/app?candidateParentId=event-ijtema&q=Khalid"});
    check(record,"event leader sees name-only candidate",eventCandidates.status===200&&eventCandidates.data.candidates.some(p=>p.id==="p-outsider"&&Object.keys(p).length===2),"policy-pass");
    check(record,"event leader can assign candidate to team",(await api(base,"admin",{action:"createItem",kind:"team",parentId:"event-ijtema",title:"Candidate team",data:{personId:"p-outsider",details:"Synthetic"}})).status===200,"policy-pass");
    check(record,"nonleader event candidate search denied",(await api(base,"member",undefined,{path:"/api/app?candidateParentId=event-ijtema&q=Khalid"})).status===403,"policy-pass");
  });
}
async function onboarding() {
  await session("Task 06 invitation and imported identity",async(base,record,{directory,env})=>{
    const add=async(name,email)=>api(base,"admin",{action:"addPerson",name,email});
    const target=await add("New Audit Worker","new@example.test");
    check(record,"imported record created unlinked",target.status===200,"policy-pass",{status:target.status});
    const duplicate=await add("New Audit Worker","new@example.test");
    check(record,"duplicate name and email remain distinct pending review",duplicate.status===200&&duplicate.data.id!==target.data.id,"policy-pass");
    check(record,"imported worker added to weekend",(await api(base,"admin",{action:"addMember",jamaatId:"jamaat-weekend",personId:target.data.id})).status===200,"policy-pass");
    const assignment=await api(base,"admin",{action:"createItem",kind:"assignment",parentId:"jamaat-weekend",title:"Imported worker Khidmah",data:{amal:"Khidmah",date:"2026-10-02",personId:target.data.id}});
    check(record,"imported worker assigned Khidmah",assignment.status===200,"policy-pass",{status:assignment.status});
    const duty=await api(base,"admin",{action:"createItem",kind:"duty",parentId:"team-khidmah",title:"Imported worker duty",data:{personId:target.data.id,details:"Synthetic"}});
    check(record,"imported worker assigned event duty",duty.status===200,"policy-pass",{status:duty.status});
    check(record,"ordinary member cannot invite",(await api(base,"member",{action:"createInvitation",personId:target.data.id,mode:"email-bound"})).status===403,"policy-pass");
    check(record,"other Markaz cannot invite target",(await api(base,"other-admin",{action:"createInvitation",personId:target.data.id,mode:"email-bound"})).status===404,"policy-pass");
    const invite=await api(base,"admin",{action:"createInvitation",personId:target.data.id,mode:"email-bound"});
    check(record,"leader issues personal email-bound invitation",invite.status===200&&/^[A-F0-9]{32}$/.test(invite.data.token),"policy-pass",{status:invite.status});
    check(record,"mismatched signed-in email denied",(await api(base,"new-second",{action:"claimInvitation",token:invite.data.token})).status===403,"policy-pass");
    check(record,"other Markaz signed-in identity denied",(await api(base,"other-admin",{action:"claimInvitation",token:invite.data.token})).status===403,"policy-pass");
    const listed=await api(base,"admin");
    check(record,"leader sees invitation status without secret code",listed.data.invitations.some(i=>i.id===invite.data.id)&&!JSON.stringify(listed.data).includes(invite.data.token),"policy-pass");
    check(record,"member cannot list invitations",(await api(base,"member")).data.invitations.length===0,"policy-pass");
    const claim=await api(base,"new",{action:"claimInvitation",token:invite.data.token});
    check(record,"first sign-in claims exact imported person",claim.status===200&&claim.data.claimed,"policy-pass",{status:claim.status,data:claim.data});
    const joined=await api(base,"new");
    check(record,"same imported ID and weekend membership survive",joined.data.me.id===target.data.id&&joined.data.memberships.some(m=>m.personId===target.data.id&&m.jamaatId==="jamaat-weekend"),"policy-pass");
    check(record,"Khidmah and event duty survive claim",joined.data.objects.some(o=>o.id===assignment.data.id&&o.data.personId===target.data.id)&&joined.data.objects.some(o=>o.id===duty.data.id&&o.data.personId===target.data.id),"policy-pass");
    check(record,"matching duplicate remains unlinked",(await api(base,"admin")).data.people.some(p=>p.id===duplicate.data.id&&p.linked===false),"policy-pass");
    check(record,"claimed invitation cannot be reused",(await api(base,"new-second",{action:"claimInvitation",token:invite.data.token})).status===410,"policy-pass");

    check(record,"contactless email-bound issue rejected",(await api(base,"admin",{action:"createInvitation",personId:"p-unlinked",mode:"email-bound"})).status===400,"policy-pass");
    check(record,"assisted issue requires verified identity confirmation",(await api(base,"admin",{action:"createInvitation",personId:"p-unlinked",mode:"assisted"})).status===400,"policy-pass");
    const assisted=await api(base,"admin",{action:"createInvitation",personId:"p-unlinked",mode:"assisted",identityConfirmed:true});
    check(record,"leader issues contactless assisted invitation",assisted.status===200,"policy-pass");
    check(record,"assisted code blocked across Markaz",(await api(base,"other-admin",{action:"claimInvitation",token:assisted.data.token})).status===403,"policy-pass");
    check(record,"contactless person claims exact record",(await api(base,"new-contactless",{action:"claimInvitation",token:assisted.data.token})).status===200&&(await api(base,"new-contactless")).data.me.id==="p-unlinked","policy-pass");

    const revokedTarget=await add("Revoked synthetic","revoked@example.test");
    const revoked=await api(base,"admin",{action:"createInvitation",personId:revokedTarget.data.id,mode:"assisted",identityConfirmed:true});
    check(record,"leader revokes pending invitation",(await api(base,"admin",{action:"revokeInvitation",invitationId:revoked.data.id})).status===200,"policy-pass");
    check(record,"revoked code denied",(await api(base,"new-second",{action:"claimInvitation",token:revoked.data.token})).status===410,"policy-pass");
    const expiring=await api(base,"admin",{action:"createInvitation",personId:revokedTarget.data.id,mode:"assisted",identityConfirmed:true,expiresDays:1});
    command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--command",`UPDATE invitations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = '${expiring.data.id}'`],env);
    check(record,"expired code denied",(await api(base,"new-second",{action:"claimInvitation",token:expiring.data.token})).status===410,"policy-pass");
    const correctionTarget=await add("Wrong contact synthetic","second@example.test");
    const oldContactInvite=await api(base,"admin",{action:"createInvitation",personId:correctionTarget.data.id,mode:"email-bound"});
    const oldCorrectionContact=(await api(base,"admin")).data.people.find(row=>row.id===correctionTarget.data.id);
    check(record,"leader changes a contact that had an active invitation",(await api(base,"admin",{action:"updatePersonContact",personId:correctionTarget.data.id,expectedPerson:{name:oldCorrectionContact.name,phone:oldCorrectionContact.phone,email:oldCorrectionContact.email},name:"Corrected contact synthetic",email:"corrected@example.test"})).status===200,"policy-pass");
    check(record,"contact change invalidates old email-bound code",(await api(base,"new-second",{action:"claimInvitation",token:oldContactInvite.data.token})).status===410,"policy-pass");

    const before=(await api(base,"admin")).data.markaz.joinCode;
    const rotated=await api(base,"admin",{action:"rotateJoinCode"});
    check(record,"leader rotates general join code",rotated.status===200&&rotated.data.code!==before,"policy-pass");
    check(record,"old general join code denied",(await api(base,"new-second",{action:"joinMarkaz",code:before,name:"Second Audit Worker"})).status===400,"policy-pass");
    check(record,"new general code joins without access grant",(await api(base,"new-second",{action:"joinMarkaz",code:rotated.data.code,name:"Second Audit Worker"})).status===200,"policy-pass");
    const source=(await api(base,"new-second")).data.me.id;
    const mergeTarget=await add("Second Audit Worker","second@example.test");
    check(record,"review target added",mergeTarget.status===200,"policy-pass");
    check(record,"target weekend membership set",(await api(base,"admin",{action:"addMember",jamaatId:"jamaat-weekend",personId:mergeTarget.data.id})).status===200,"policy-pass");
    const targetDuty=await api(base,"admin",{action:"createItem",kind:"assignment",parentId:"jamaat-weekend",title:"Reviewed identity assignment",data:{amal:"Khidmah",date:"2026-10-03",personId:mergeTarget.data.id}});
    check(record,"target work exists before merge",targetDuty.status===200,"policy-pass");
    const ownJamaat=await api(base,"new-second",{action:"createJamaat",title:"Second worker draft",startAt:"2026-10-06",endAt:"2026-10-07",kind:"regular",route:"Synthetic route",selfAmeer:true});
    check(record,"source account has independent draft history",ownJamaat.status===200,"policy-pass",{status:ownJamaat.status});
    const mergeInvite=await api(base,"admin",{action:"createInvitation",personId:mergeTarget.data.id,mode:"email-bound"});
    const request=await api(base,"new-second",{action:"claimInvitation",token:mergeInvite.data.token});
    check(record,"existing account requires leader-reviewed merge",request.status===200&&request.data.pending,"policy-pass",{status:request.status});
    check(record,"claim retry is idempotently pending",(await api(base,"new-second",{action:"claimInvitation",token:mergeInvite.data.token})).data.pending===true,"policy-pass");
    check(record,"ordinary member cannot review duplicate",(await api(base,"member",{action:"reviewClaim",claimId:"unknown",decision:"approve"})).status===403,"policy-pass");
    const leaderView=await api(base,"admin"),claimRow=leaderView.data.claimRequests.find(c=>c.targetPersonId===mergeTarget.data.id&&c.status==="pending");
    check(record,"leader sees exact source and target records",claimRow?.sourcePersonId===source,"policy-pass",{claimRow});
    check(record,"other Markaz cannot review claim",(await api(base,"other-admin",{action:"reviewClaim",claimId:claimRow.id,decision:"approve"})).status===404,"policy-pass");
    const approved=await api(base,"admin",{action:"reviewClaim",claimId:claimRow.id,decision:"approve"});
    check(record,"leader approves reviewed duplicate",approved.status===200&&approved.data.merged,"policy-pass",{status:approved.status,data:approved.data});
    const merged=await api(base,"new-second");
    check(record,"same account now resolves imported target ID",merged.data.me.id===mergeTarget.data.id,"policy-pass",{id:merged.data.me.id});
    check(record,"both source draft and target weekend work survive",merged.data.memberships.some(m=>m.jamaatId===ownJamaat.data.id&&m.personId===mergeTarget.data.id)&&merged.data.memberships.some(m=>m.jamaatId==="jamaat-weekend"&&m.personId===mergeTarget.data.id)&&merged.data.objects.some(o=>o.id===targetDuty.data.id&&o.data.personId===mergeTarget.data.id),"policy-pass");
    check(record,"source references moved and archived source hidden",merged.data.objects.some(o=>o.id===ownJamaat.data.id&&o.createdBy===mergeTarget.data.id&&o.data.pendingAmeerId===mergeTarget.data.id)&&!(await api(base,"admin")).data.people.some(p=>p.id===source),"policy-pass");
    check(record,"review cannot be repeated",(await api(base,"admin",{action:"reviewClaim",claimId:claimRow.id,decision:"approve"})).status===409,"policy-pass");
    check(record,"old source ID cannot be reassigned",(await api(base,"admin",{action:"addMember",jamaatId:"jamaat-weekend",personId:source})).status===400,"policy-pass");
    const overlapTarget=await add("Duplicate weekend member","member@example.test");
    check(record,"overlap target joins same Jamaat",(await api(base,"admin",{action:"addMember",jamaatId:"jamaat-weekend",personId:overlapTarget.data.id})).status===200,"policy-pass");
    const overlapInvite=await api(base,"admin",{action:"createInvitation",personId:overlapTarget.data.id,mode:"email-bound"});
    check(record,"existing member submits conflicting duplicate",(await api(base,"member",{action:"claimInvitation",token:overlapInvite.data.token})).data.pending===true,"policy-pass");
    const overlapClaim=(await api(base,"admin")).data.claimRequests.find(c=>c.targetPersonId===overlapTarget.data.id);
    check(record,"overlapping memberships block automatic merge",(await api(base,"admin",{action:"reviewClaim",claimId:overlapClaim.id,decision:"approve"})).status===409,"policy-pass");
    check(record,"denial retains both records and closes request",(await api(base,"admin",{action:"reviewClaim",claimId:overlapClaim.id,decision:"deny"})).status===200&&(await api(base,"member")).data.me.id==="p-member","policy-pass");

    check(record,"ordinary member cannot correct another contact",(await api(base,"member",{action:"updatePersonContact",personId:"p-unlinked",name:"Corrected Offline",email:"contactless@example.test"})).status===403,"policy-pass");
    const oldUnlinked=(await api(base,"admin")).data.people.find(row=>row.id==="p-unlinked");
    const correction=await api(base,"ameer",{action:"updatePersonContact",personId:"p-unlinked",expectedPerson:{name:oldUnlinked.name,phone:oldUnlinked.phone,email:oldUnlinked.email},name:"Corrected Offline",email:"corrected@example.test"});
    check(record,"approved Ameer corrects member contact",correction.status===200,"policy-pass",{status:correction.status});
    const corrected=await api(base,"admin");
    check(record,"leader sees before/after correction history",corrected.data.contactCorrections.some(c=>c.personId==="p-unlinked"&&c.before.email===null&&c.after.email==="corrected@example.test"),"policy-pass");
    check(record,"contact correction does not change sign-in linkage",(await api(base,"new-contactless")).data.me.id==="p-unlinked","policy-pass");
  });
  await session("Task 06 concurrent claim",async(base,record)=>{
    const target=await api(base,"admin",{action:"addPerson",name:"Race candidate"});
    const invitation=await api(base,"admin",{action:"createInvitation",personId:target.data.id,mode:"assisted",identityConfirmed:true});
    const attempts=await Promise.all([api(base,"new",{action:"claimInvitation",token:invitation.data.token}),api(base,"new-second",{action:"claimInvitation",token:invitation.data.token})]);
    check(record,"only one concurrent claimant links",attempts.filter(r=>r.status===200&&r.data.claimed).length===1&&attempts.filter(r=>r.status===409||r.status===410).length===1,"policy-pass",{statuses:attempts.map(r=>r.status)});
    const readers=await Promise.all([api(base,"new"),api(base,"new-second")]);
    check(record,"exactly one account owns claimed person",readers.filter(r=>r.data.me?.id===target.data.id).length===1,"policy-pass");
  });
  await session("Task 06 invitation from empty database",async(base,record)=>{
    check(record,"new Markaz setup with invitation migration",(await api(base,"new",{action:"createMarkaz",name:"Empty synthetic Markaz",yourName:"Synthetic leader"})).status===200,"policy-pass");
    const target=await api(base,"new",{action:"addPerson",name:"Empty database roster member",email:"second@example.test"});
    check(record,"new Markaz can create unlinked roster person",target.status===200,"policy-pass");
    const invitation=await api(base,"new",{action:"createInvitation",personId:target.data.id,mode:"email-bound"});
    check(record,"new Markaz can issue personal invitation",invitation.status===200,"policy-pass");
    const claimed=await api(base,"new-second",{action:"claimInvitation",token:invitation.data.token});
    check(record,"empty-database invite links exact roster person",claimed.status===200&&(await api(base,"new-second")).data.me.id===target.data.id,"policy-pass");
  },undefined,true);
}
async function importRoster() {
  await session("Task 07 imports and pending draft roster",async(base,record)=>{
    const rows=[
      {rowNumber:2,name:"Task 07 Name Only"},
      {rowNumber:3,name:"Task 07 Phone",phone:"+1 604 555 7711"},
      {rowNumber:4,name:"Task 07 Email",email:"task07@example.test"},
      {rowNumber:5,name:"Task 07 Full",phone:"+1 604 555 7712",email:"full07@example.test"},
      {rowNumber:6,name:"Task 07 Name Only"},
      {rowNumber:7,name:"Task 07 Bad Email",email:"invalid"},
      {rowNumber:8,name:""}
    ];
    check(record,"ordinary member cannot import",(await api(base,"member",{action:"importPeople",rows})).status===403);
    check(record,"pending creator cannot import globally",(await api(base,"pending",{action:"importPeople",rows})).status===403);
    check(record,"pending creator cannot import to another draft",(await api(base,"pending",{action:"importPeople",jamaatId:"jamaat-weekend",rows})).status===403);
    check(record,"cross-Markaz target hidden",(await api(base,"admin",{action:"importPeople",jamaatId:"jamaat-other",rows})).status===404);
    const first=await api(base,"admin",{action:"importPeople",rows});
    check(record,"four formats and per-row outcomes",first.status===200&&first.data.added===4&&first.data.duplicate===1&&first.data.rejected===2&&first.data.results.map(x=>x.status).join(",")==="added,added,added,added,duplicate,rejected,rejected","policy-pass",{status:first.status,data:first.data});
    const again=await api(base,"admin",{action:"importPeople",rows:[rows[0],{rowNumber:7,name:"Task 07 Bad Email",email:"fixed07@example.test"}]});
    check(record,"retry does not duplicate saved record and accepts corrected row",again.status===200&&again.data.added===1&&again.data.duplicate===1&&again.data.rejected===0,"policy-pass",{data:again.data});
    const stored=await api(base,"admin");
    check(record,"saved optional fields persist",stored.data.people.some(p=>p.name==="Task 07 Name Only"&&!p.phone&&!p.email)&&stored.data.people.some(p=>p.name==="Task 07 Phone"&&p.phone==="+1 604 555 7711"&&!p.email)&&stored.data.people.some(p=>p.name==="Task 07 Email"&&!p.phone&&p.email==="task07@example.test"));
    check(record,"empty import cannot report saved",(await api(base,"admin",{action:"importPeople",rows:[]})).status===400);
    check(record,"over 500 rows rejected",(await api(base,"admin",{action:"importPeople",rows:Array.from({length:501},(_,i)=>({name:`Task 07 Limit ${i}`}))})).status===400);
    const draft=await api(base,"pending",{action:"addDraftPerson",jamaatId:"jamaat-pending",name:"Task 07 Draft One"});
    check(record,"pending creator adds a new draft member",draft.status===200&&!!draft.data.id,"policy-pass",{status:draft.status,data:draft.data});
    const pendingView=await api(base,"pending");
    check(record,"draft person is visible with membership and no directory expansion",pendingView.data.people.some(p=>p.id===draft.data.id)&&pendingView.data.memberships.some(m=>m.jamaatId==="jamaat-pending"&&m.personId===draft.data.id)&&!pendingView.data.people.some(p=>p.name==="Task 07 Name Only"));
    check(record,"other member cannot add to pending draft",(await api(base,"member",{action:"addDraftPerson",jamaatId:"jamaat-pending",name:"Denied"})).status===403);
    const draftImport=await api(base,"pending",{action:"importPeople",jamaatId:"jamaat-pending",rows:[{rowNumber:4,name:"Task 07 Draft Imported"}]});
    check(record,"pending creator imports scoped roster",draftImport.status===200&&draftImport.data.added===1&&draftImport.data.results[0].rowNumber===4);
    const scoped=(await api(base,"pending")).data;
    check(record,"imported draft person joins only own draft",scoped.people.some(p=>p.name==="Task 07 Draft Imported")&&scoped.memberships.some(m=>m.jamaatId==="jamaat-pending"&&scoped.people.some(p=>p.id===m.personId&&p.name==="Task 07 Draft Imported")));
    check(record,"approved Ameer can import globally",(await api(base,"ameer",{action:"importPeople",rows:[{name:"Task 07 Ameer"}]})).data.added===1);
    const substitute=await api(base,"admin",{action:"appointAmeer",jamaatId:"jamaat-pending",personId:"p-member"});
    check(record,"leader substitutes another Ameer",substitute.status===200);
    check(record,"former creator loses draft entry immediately",(await api(base,"pending",{action:"addDraftPerson",jamaatId:"jamaat-pending",name:"Denied Later"})).status===403);
    check(record,"former creator loses draft import immediately",(await api(base,"pending",{action:"importPeople",jamaatId:"jamaat-pending",rows:[{name:"Denied Later"}]})).status===403);
    check(record,"new approved Ameer can import to Jamaat",(await api(base,"member",{action:"importPeople",jamaatId:"jamaat-pending",rows:[{name:"Task 07 New Ameer"}]})).data.added===1);
  });
}
async function privacyReview() {
  await session("Task 08 hidden contact and nested privacy",async(base,record)=>{
    const pendingBefore=(await api(base,"pending")).data;
    check(record,"pending creator cannot see hidden approved Ameer record",!pendingBefore.people.some(p=>p.id==="p-ameer"));
    const member=(await api(base,"member")).data;
    const visibleAmeer=member.people.find(p=>p.id==="p-ameer");
    check(record,"visible colleague name does not expose private contacts",!!visibleAmeer?.name&&visibleAmeer.phone===null&&visibleAmeer.email===null);
    check(record,"ordinary member cannot read incident or private nested Mashwara",!["incident-weekend","mashwara-private","umoor-private","opinion-private"].some(id=>member.objects.some(o=>o.id===id)));
    const planner=(await api(base,"planner")).data;
    check(record,"quarantined legacy grant has original review evidence and no sensitive live scope",planner.repairReviews.length===0&&!planner.objects.some(o=>o.id==="incident-weekend")&&!planner.objects.some(o=>o.id==="money-collection")&&planner.memberships.some(m=>m.jamaatId==="jamaat-weekend"&&m.personId==="p-planner"&&!m.permissions.scopes.includes("contacts")));
    const leader=(await api(base,"admin")).data;
    check(record,"leader retains old grant review evidence",leader.repairReviews.some(r=>r.kind==="legacy-grant"&&r.targetId==="membership-jamaat-weekend-p-planner"&&String(r.original).includes("manage")));
    const exact={rowNumber:2,name:"Abdul Rahman",phone:"+1 604 555 0103",email:"ameer@example.test"};
    const probe=await api(base,"pending",{action:"importPeople",jamaatId:"jamaat-pending",rows:[exact]});
    if(reproduce) {
      check(record,"F08-01 hidden contact confirmation reproduced",probe.status===200&&probe.data.duplicate===1,"known-defect-reproduced",{status:probe.status,outcome:probe.data.results?.[0]?.status});
      result.classifications.push({finding:"F08-01",kind:"known-defect-reproduced",severity:"high",actual:"duplicate confirms exact hidden contact",intended:"no contact oracle"});
    } else {
      check(record,"hidden contact probe does not confirm global exact match",probe.status===200&&probe.data.added===1&&probe.data.duplicate===0,"policy-pass",{status:probe.status,outcome:probe.data.results?.[0]?.status});
      const retry=await api(base,"pending",{action:"importPeople",jamaatId:"jamaat-pending",rows:[exact]});
      check(record,"same importer's own record deduplicates on retry",retry.status===200&&retry.data.duplicate===1&&retry.data.added===0,"policy-pass",{data:retry.data});
    }
    const pendingAfter=(await api(base,"pending")).data;
    check(record,"original hidden person remains outside draft view",!pendingAfter.people.some(p=>p.id==="p-ameer"));
    const spoof=await fetch(`${base}/api/app`,{headers:{"x-audit-persona":"member","oai-authenticated-user-id":"audit-auth-admin","oai-authenticated-user-email":"admin@example.test"}});
    const spoofed=await spoof.json();
    check(record,"synthetic trusted proxy strips caller identity headers",spoof.status===200&&spoofed.me.id==="p-member");
    const privateWrite=await api(base,"member",{action:"recordOpinion",umoorId:"umoor-private",note:"Denied synthetic probe"});
    check(record,"private nested write denied",privateWrite.status===403,"policy-pass",{status:privateWrite.status});
    const created=await api(base,"pending",{action:"createItem",kind:"message",parentId:"jamaat-pending",title:"Task 08 private draft message",data:{text:"TASK08_DRAFT_MESSAGE"}});
    check(record,"draft message setup",created.status===200&&!!created.data.id);
    check(record,"member initially sees shared draft message",(await api(base,"member")).data.objects.some(o=>o.id===created.data.id));
    const removed=await api(base,"admin",{action:"removeMember",jamaatId:"jamaat-pending",personId:"p-member"});
    check(record,"leader removes member from draft",removed.status===200);
    check(record,"removed member loses draft message and roster immediately",!(await api(base,"member")).data.objects.some(o=>o.id===created.data.id)&&!(await api(base,"member")).data.objects.some(o=>o.id==="jamaat-pending"));
    check(record,"removed member cannot write to former Jamaat",(await api(base,"member",{action:"createItem",kind:"message",parentId:"jamaat-pending",title:"Denied",data:{text:"Denied"}})).status===403);
  });
  await session("Task 08 orphan approved Ameer authority",async(base,record,{directory,env})=>{
    command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--command","DELETE FROM memberships WHERE person_id = 'p-ameer' AND jamaat_id IN ('jamaat-weekend','jamaat-mastooraat')"],env);
    check(record,"synthetic orphan Ameer has no Jamaat membership",!(await api(base,"ameer")).data.memberships.some(m=>m.personId==="p-ameer"));
    const add=await api(base,"ameer",{action:"addPerson",name:"Task 08 Orphan Added"});
    const mashwara=await api(base,"ameer",{action:"createMashwara",title:"Task 08 Orphan Plan",type:"general",startAt:"2026-10-03T20:00:00-07:00",recurrence:"none",ameerId:"p-ameer",visibility:"markaz"});
    if(reproduce) {
      check(record,"F08-02 orphan Ameer global creation reproduced",add.status===200&&mashwara.status===200,"known-defect-reproduced",{add:add.status,mashwara:mashwara.status});
      result.classifications.push({finding:"F08-02",kind:"known-defect-reproduced",severity:"high",actual:"orphan approved Ameer can add person and Mashwara",intended:"membership required"});
    } else {
      check(record,"orphan Ameer cannot add people",add.status===403,"policy-pass",{status:add.status});
      check(record,"orphan Ameer cannot create Mashwara",mashwara.status===403,"policy-pass",{status:mashwara.status});
    }
    check(record,"orphan Ameer cannot import people",(await api(base,"ameer",{action:"importPeople",rows:[{name:"Task 08 Denied"}]})).status===403);
  });
}
async function timeReview() {
  await session("Task 09 date and timezone contract",async(base,record)=>{
    const before=(await api(base,"admin")).data;
    check(record,"existing Markaz defaults to Vancouver zone",before.markaz.timeZone==="America/Vancouver");
    const trip=before.objects.find(o=>o.id==="jamaat-weekend");
    check(record,"existing three-day trip dates unchanged",trip.startAt==="2026-10-02"&&trip.endAt==="2026-10-04");
    const meeting=await api(base,"admin",{action:"createMashwara",title:"Task 09 Friday evening",type:"general",startAt:"2026-10-02T20:00:00-07:00",recurrence:"none",ameerId:"p-admin",visibility:"markaz"});
    check(record,"offset meeting created",meeting.status===200,"policy-pass",{status:meeting.status});
    const meetingRow=(await api(base,"admin")).data.objects.find(o=>o.id===meeting.data.id);
    check(record,"meeting stores exact UTC instant and named display zone",meetingRow.startAt==="2026-10-03T03:00:00.000Z"&&meetingRow.data.timeZone==="America/Vancouver","policy-pass",{startAt:meetingRow.startAt});
    check(record,"date-only general meeting rejected",(await api(base,"admin",{action:"createMashwara",title:"Untimed",startAt:"2026-10-02"})).status===400);
    check(record,"timed Jamaat trip rejected",(await api(base,"admin",{action:"createJamaat",title:"Timed trip",startAt:"2026-10-02T20:00:00-07:00",endAt:"2026-10-04T20:00:00-07:00"})).status===400);
    const stay=await api(base,"admin",{action:"createItem",kind:"stay",title:"Task 09 timed stay",parentId:"jamaat-weekend",startAt:"2026-10-02T18:15:00-07:00",endAt:"2026-10-02T19:45:00-07:00",data:{placeId:"place-1",hostStatus:"proposed"}});
    check(record,"timed stay created",stay.status===200,"policy-pass",{status:stay.status});
    const stayRow=(await api(base,"admin")).data.objects.find(o=>o.id===stay.data.id);
    check(record,"timed stay keeps arrival and departure instants",stayRow.startAt==="2026-10-03T01:15:00.000Z"&&stayRow.endAt==="2026-10-03T02:45:00.000Z"&&stayRow.data.timeZone==="America/Vancouver");
    const routeBefore=(await api(base,"admin")).data.objects;
    const stayBefore=routeBefore.find(o=>o.id===stay.data.id),tripBefore=routeBefore.find(o=>o.id==="jamaat-weekend");
    const stayEdit=await api(base,"admin",{action:"saveRoute",id:stay.data.id,expectedUpdatedAt:stayBefore.updatedAt,jamaatUpdatedAt:tripBefore.updatedAt,linkedVersions:routeBefore.filter(o=>o.parentId===tripBefore.id&&(o.kind==="stay"||o.kind==="assignment"||o.kind==="mashwara"&&o.data.daily===true)).map(o=>({id:o.id,updatedAt:o.updatedAt})),title:stayBefore.title,startAt:"2026-10-02T18:30:00-07:00",endAt:"2026-10-02T20:00:00-07:00",planMode:"keep",reconfirm:false,placeId:stayBefore.data.placeId,hostStatus:stayBefore.data.hostStatus,conditions:stayBefore.data.conditions||""});
    check(record,"timed stay edit preserves clock values",stayEdit.status===200&&(await api(base,"admin")).data.objects.find(o=>o.id===stay.data.id).endAt==="2026-10-03T03:00:00.000Z");
    check(record,"mixed stay formats rejected",(await api(base,"admin",{action:"createItem",kind:"stay",title:"Mixed",parentId:"jamaat-weekend",startAt:"2026-10-02",endAt:"2026-10-03T02:00:00Z",data:{placeId:"place-1"}})).status===400);
    check(record,"timed meeting cannot be erased by date-only edit",(await versionedEdit(base,"admin",{action:"updateItem",id:meeting.data.id,startAt:"2026-10-05"})).status===400);
    check(record,"worker cannot change Markaz timezone",(await api(base,"member",{action:"setMarkazTimeZone",timeZone:"America/Toronto"})).status===403);
    check(record,"invalid timezone rejected",(await api(base,"admin",{action:"setMarkazTimeZone",timeZone:"Not/AZone"})).status===400);
    check(record,"leader can set Toronto timezone",(await api(base,"admin",{action:"setMarkazTimeZone",timeZone:"America/Toronto"})).status===200&&(await api(base,"admin")).data.markaz.timeZone==="America/Toronto");
  });
  await session("Task 09 preserved historical dates",async(base,record)=>{
    const leader=(await api(base,"admin")).data;
    check(record,"invalid trip preserved unchanged",leader.objects.some(o=>o.id==="legacy-invalid-trip"&&o.startAt==="2026-02-30"));
    check(record,"reversed trip preserved unchanged",leader.objects.some(o=>o.id==="legacy-reversed-trip"&&o.startAt==="2026-10-04"&&o.endAt==="2026-10-02"));
    check(record,"untimed meeting preserved unchanged",leader.objects.some(o=>o.id==="legacy-untimed-meeting"&&o.startAt==="2026-10-02"));
    check(record,"invalid trip original queued for leader review",leader.repairReviews.some(r=>r.kind==="schedule-date"&&r.targetId==="legacy-invalid-trip"&&r.original.includes("2026-02-30")));
    check(record,"reversed trip queued for leader review",leader.repairReviews.some(r=>r.kind==="schedule-date"&&r.targetId==="legacy-reversed-trip"));
    check(record,"untimed meeting original queued for leader review",leader.repairReviews.some(r=>r.kind==="schedule-date"&&r.targetId==="legacy-untimed-meeting"));
    check(record,"ordinary member cannot see date repair originals",(await api(base,"member")).data.repairReviews.length===0);
  },"audit/repair-task-09-legacy-fixture.sql");
  await session("Task 09 new Markaz timezone",async(base,record)=>{
    check(record,"invalid new Markaz timezone rejected",(await api(base,"new",{action:"createMarkaz",name:"Synthetic Toronto",yourName:"Test admin",timeZone:"Mars/Base"})).status===400);
    const created=await api(base,"new",{action:"createMarkaz",name:"Synthetic Toronto",yourName:"Test admin",timeZone:"America/Toronto"});
    check(record,"new Toronto Markaz created",created.status===200);
    check(record,"new Markaz retains selected IANA zone",(await api(base,"new")).data.markaz.timeZone==="America/Toronto");
  },undefined,true);
}
function routePayload(objects,targetId,changes={}) {
  const target=objects.find(object=>object.id===targetId);
  const jamaat=target.kind==="jamaat"?target:objects.find(object=>object.id===target.parentId);
  return {action:"saveRoute",id:target.id,expectedUpdatedAt:target.updatedAt,jamaatUpdatedAt:jamaat.updatedAt,linkedVersions:objects.filter(object=>object.parentId===jamaat.id&&(object.kind==="stay"||object.kind==="assignment"||object.kind==="mashwara"&&object.data.daily===true)).map(object=>({id:object.id,updatedAt:object.updatedAt})),title:target.title,startAt:target.startAt,endAt:target.endAt,...(target.kind==="stay"?{placeId:target.data.placeId,hostStatus:target.data.hostStatus,conditions:target.data.conditions||""}:{route:target.data.route||""}),...changes};
}
async function routeReview() {
  await session("Markaz route with different masjid durations",async(base,record)=>{
    const created=await api(base,"markaz-ameer",{action:"createJamaat",title:"Synthetic six-day route",startAt:"2026-11-06",endAt:"2026-11-11",kind:"regular",ameerId:"p-ameer"});
    check(record,"Markaz Ameer creates and assigns route Jamaat",created.status===200);
    const jid=created.data.id;
    const stops=[["place-1","2026-11-06","2026-11-07",2],["place-2","2026-11-08","2026-11-10",3],["place-3","2026-11-11","2026-11-11",1]];
    const payload=(stop)=>({action:"createItem",kind:"stay",parentId:jid,title:`Synthetic ${stop[3]} day stop`,startAt:stop[1],endAt:stop[2],data:{placeId:stop[0],hostStatus:"confirmed",conditions:"Synthetic host confirmation"}});
    for(const stop of stops){const saved=await api(base,"markaz-ameer",payload(stop));check(record,`Markaz Ameer saves ${stop[3]} days at ${stop[0]}`,saved.status===200);}
    const state=(await api(base,"markaz-ameer")).data;
    const saved=state.objects.filter(o=>o.kind==="stay"&&o.parentId===jid).sort((a,b)=>a.startAt.localeCompare(b.startAt));
    check(record,"all three masjid durations and host confirmations persist",saved.length===3&&saved.every((row,index)=>row.startAt===stops[index][1]&&row.endAt===stops[index][2]&&row.data.placeId===stops[index][0]&&row.data.hostStatus==="confirmed"));
    check(record,"ordinary member cannot add route stops",(await api(base,"member",payload(stops[0]))).status===403);
    check(record,"other Markaz leader cannot write this route",(await api(base,"other-admin",payload(stops[0]))).status===404);
    check(record,"overlapping confirmed masjid stop rejected",(await api(base,"markaz-ameer",payload(["place-3","2026-11-07","2026-11-08",2]))).status===400);
    check(record,"stop extending beyond trip rejected",(await api(base,"markaz-ameer",payload(["place-3","2026-11-11","2026-11-12",2]))).status===400);
    for(const [place,date] of [["place-1","2026-11-07"],["place-2","2026-11-09"],["place-3","2026-11-11"]]){
      const daily=await api(base,"markaz-ameer",{action:"createDailyMashwara",jamaatId:jid,date,ameerId:"p-ameer"});
      const read=(await api(base,"markaz-ameer")).data.objects.find(o=>o.id===daily.data.id);
      check(record,`daily Mashwara ${date} uses its planned masjid`,daily.status===200&&read?.data.locationId===place);
    }
  });
  await session("Task 10 linked route changes",async(base,record)=>{
    let before=(await api(base,"admin")).data.objects;
    const invalid=(await api(base,"admin",{action:"createItem",kind:"stay",parentId:"jamaat-weekend",title:"Outside",startAt:"2026-10-05",endAt:"2026-10-05",data:{placeId:"place-1"}}));
    check(record,"out-of-trip stay creation rejected",invalid.status===400,"policy-pass",{status:invalid.status});
    const overlap=await api(base,"admin",{action:"createItem",kind:"stay",parentId:"jamaat-weekend",title:"Overlap",startAt:"2026-10-02T18:00:00-07:00",endAt:"2026-10-02T19:00:00-07:00",data:{placeId:"place-2",hostStatus:"confirmed"}});
    check(record,"overlapping confirmed stay creation rejected",overlap.status===400,"policy-pass",{status:overlap.status});
    check(record,"direct stay date overwrite requires route editor",(await versionedEdit(base,"admin",{action:"updateItem",id:"stay-2",startAt:"2026-10-03T10:00:00-07:00"})).status===409);
    const daily=await api(base,"admin",{action:"createDailyMashwara",jamaatId:"jamaat-weekend",date:"2026-10-02",ameerId:"p-ameer"});
    check(record,"daily plan created before linked move",daily.status===200,"policy-pass",{status:daily.status});
    const umoor=(await api(base,"admin")).data.objects.find(o=>o.kind==="umoor"&&o.parentId===daily.data.id);
    const decision=await api(base,"admin",{action:"setUmoorOutcome",umoorId:umoor.id,decision:"Keep the Friday decision attributed.",followUp:"Review after travel.",done:true});
    check(record,"existing daily decision recorded before move",decision.status===200);
    before=(await api(base,"admin")).data.objects;
    const denied=await api(base,"member",routePayload(before,"jamaat-weekend",{startAt:"2026-10-09",endAt:"2026-10-11",stayMode:"shift",planMode:"shift",reconfirm:true,retainHistory:true}));
    check(record,"ordinary member cannot reschedule route",denied.status===403,"policy-pass",{status:denied.status});
    const detached=await api(base,"admin",routePayload(before,"jamaat-weekend",{startAt:"2026-10-09",endAt:"2026-10-11",stayMode:"keep",planMode:"keep",retainHistory:true}));
    check(record,"keeping detached stays is rejected",detached.status===400,"policy-pass",{status:detached.status});
    const unacknowledged=await api(base,"admin",routePayload(before,"jamaat-weekend",{startAt:"2026-10-09",endAt:"2026-10-11",stayMode:"shift",planMode:"shift",reconfirm:true}));
    check(record,"dated independent history requires explicit retention choice",unacknowledged.status===400&&String(unacknowledged.data.error).includes("historical"));
    const noReconfirm=await api(base,"admin",routePayload(before,"jamaat-weekend",{startAt:"2026-10-09",endAt:"2026-10-11",stayMode:"shift",planMode:"shift",reconfirm:false,retainHistory:true}));
    check(record,"moved confirmed host requires reconfirmation",noReconfirm.status===400,"policy-pass",{status:noReconfirm.status});
    const unchanged=(await api(base,"admin")).data.objects;
    check(record,"rejected move preserves every original stop",["stay-1","stay-2","stay-3"].every(id=>unchanged.find(o=>o.id===id).startAt===before.find(o=>o.id===id).startAt));
    const payload=routePayload(before,"jamaat-weekend",{startAt:"2026-10-09",endAt:"2026-10-11",stayMode:"shift",planMode:"shift",reconfirm:true,retainHistory:true});
    const [first,second]=await Promise.all([api(base,"admin",payload),api(base,"admin",payload)]);
    check(record,"two stale concurrent moves yield one winner and one conflict",[first.status,second.status].sort().join(",")==="200,409","policy-pass",{statuses:[first.status,second.status]});
    const after=(await api(base,"admin")).data.objects;
    check(record,"whole weekend and all three stops shifted atomically",after.find(o=>o.id==="jamaat-weekend").startAt==="2026-10-09"&&["stay-1","stay-2","stay-3"].every((id,index)=>localDay(after.find(o=>o.id===id).startAt,"America/Vancouver")===`2026-10-${String(9+index).padStart(2,"0")}`));
    check(record,"confirmed host reset for reconfirmation",after.find(o=>o.id==="stay-1").data.hostStatus==="contacted");
    const dailyAfter=after.find(o=>o.id===daily.data.id);
    check(record,"daily Mashwara day and venue follow first stop",dailyAfter.startAt==="2026-10-09"&&dailyAfter.data.date==="2026-10-09"&&dailyAfter.data.locationId==="place-1");
    const dailyRetry=await api(base,"admin",{action:"createDailyMashwara",jamaatId:"jamaat-weekend",date:"2026-10-09",ameerId:"p-ameer"});
    check(record,"moved daily Mashwara opens by new date without duplicate",dailyRetry.status===200&&dailyRetry.data.existing===true&&dailyRetry.data.id===daily.data.id);
    check(record,"independent private note and money retain original contents",after.find(o=>o.id==="note-weekend")?.data.text===before.find(o=>o.id==="note-weekend")?.data.text&&after.find(o=>o.id==="money-collection")?.data.amountCents===before.find(o=>o.id==="money-collection")?.data.amountCents);
    check(record,"daily decision and follow-up remain attributed",after.find(o=>o.id===umoor.id)?.data.decision==="Keep the Friday decision attributed."&&after.find(o=>o.id===umoor.id)?.data.followUp==="Review after travel.");
    check(record,"stale retry did not apply a second move",(await api(base,"admin",payload)).status===409);
    const grant=await api(base,"admin",{action:"setMemberPermission",jamaatId:"jamaat-weekend",personId:"p-planner",scopes:["route"]});
    check(record,"leader grants route scope for planner test",grant.status===200);
    const plannerObjects=(await api(base,"planner")).data.objects;
    const plannerEdit=await api(base,"planner",routePayload(plannerObjects,"stay-2",{conditions:"Planner confirmed Saturday entrance."}));
    check(record,"route planner edits Saturday stay",plannerEdit.status===200,"policy-pass",{status:plannerEdit.status});
    check(record,"planner edit readback retains all stop dates",(await api(base,"admin")).data.objects.find(o=>o.id==="stay-2").data.conditions==="Planner confirmed Saturday entrance.");
  });
  await session("Task 10 atomic rollback",async(base,record)=>{
    const before=(await api(base,"admin")).data.objects;
    const payload=routePayload(before,"jamaat-weekend",{startAt:"2026-10-09",endAt:"2026-10-11",stayMode:"shift",planMode:"shift",reconfirm:true,retainHistory:true});
    const result=await api(base,"admin",payload);
    check(record,"forced middle-stop failure returns error",result.status===503,"policy-pass",{status:result.status});
    const after=(await api(base,"admin")).data.objects;
    check(record,"failed batch rolls back trip and every stop",["jamaat-weekend","stay-1","stay-2","stay-3"].every(id=>{const old=before.find(o=>o.id===id),current=after.find(o=>o.id===id);return current.startAt===old.startAt&&current.endAt===old.endAt&&JSON.stringify(current.data)===JSON.stringify(old.data);}));
    check(record,"failed batch leaves guard table reusable",(await api(base,"admin",payload)).status===503);
  },"audit/repair-task-10-rollback-trigger.sql");
}
async function seriesReview(){
  await session("Task 12 recurring Mashwara series",async(base,record)=>{
    const created=await api(base,"admin",{action:"createMashwara",title:"Task 12 Toronto weekly",type:"weekly",startAt:"2027-03-07T15:00:00.000Z",timeZone:"America/Toronto",recurrence:"weekly",seriesEndCount:4,ameerId:"p-admin",visibility:"markaz"});
    check(record,"bounded Toronto series created",created.status===200&&created.data.occurrences===4,"policy-pass",{status:created.status,data:created.data});
    const firstId=created.data.id;
    let state=(await api(base,"admin")).data;
    let meetings=state.objects.filter(row=>row.kind==="mashwara"&&row.data.seriesId===firstId).sort((a,b)=>a.data.occurrence-b.data.occurrence);
    check(record,"weekly 10 a.m. survives Toronto DST",meetings.length===4&&meetings.map(row=>localDateTimeInput(row.startAt,"America/Toronto")).every(value=>value.endsWith("T10:00"))&&meetings[1].startAt==="2027-03-14T14:00:00.000Z","policy-pass",{starts:meetings.map(row=>row.startAt)});
    const ids=meetings.map(row=>row.id);
    state=(await api(base,"admin")).data;
    check(record,"repeated load does not duplicate occurrences",state.objects.filter(row=>row.kind==="mashwara"&&row.data.seriesId===firstId).map(row=>row.id).sort().join(",")===ids.sort().join(","));
    const grant=await api(base,"admin",{action:"addCollaborator",mashwaraId:firstId,personId:"p-planner",scope:"series"});
    check(record,"series planner grant accepted",grant.status===200,"policy-pass",{status:grant.status});
    const planner=(await api(base,"planner")).data;
    check(record,"series planner sees later meetings",planner.objects.some(row=>row.id===meetings[3].id&&row.data.isSeriesPlanner===true));
    const umoor=await api(base,"planner",{action:"addUmoor",mashwaraId:meetings[1].id,title:"Task 12 recurring agenda",notes:"Original brief",recurring:true});
    check(record,"series planner adds recurring umoor",umoor.status===200&&umoor.data.count>=3,"policy-pass",{status:umoor.status,data:umoor.data});
    state=(await api(base,"admin")).data;
    const firstUmoor=state.objects.find(row=>row.kind==="umoor"&&row.parentId===meetings[1].id&&row.title==="Task 12 recurring agenda");
    check(record,"recurring umoor copied to later meeting",!!firstUmoor&&state.objects.some(row=>row.kind==="umoor"&&row.parentId===meetings[3].id&&row.data.templateId===firstUmoor.data.templateId));
    const templateEdit=await api(base,"planner",{action:"editRecurringUmoor",umoorId:firstUmoor.id,scope:"future",expectedUpdatedAt:firstUmoor.updatedAt,expectedSeriesVersion:state.series.find(row=>row.id===firstId).version,title:"Task 12 revised agenda",notes:"Revised brief"});
    check(record,"future recurring umoor edit accepted",templateEdit.status===200,"policy-pass",{status:templateEdit.status,data:templateEdit.data});
    state=(await api(base,"admin")).data;
    check(record,"future umoor updated without past copy",!state.objects.some(row=>row.kind==="umoor"&&row.parentId===meetings[0].id&&row.title==="Task 12 revised agenda")&&state.objects.some(row=>row.kind==="umoor"&&row.parentId===meetings[3].id&&row.title==="Task 12 revised agenda"));
    const marchAgenda=state.objects.find(row=>row.kind==="umoor"&&row.parentId===meetings[2].id&&row.title==="Task 12 revised agenda");
    const laterAgendaEdit=await api(base,"planner",{action:"editRecurringUmoor",umoorId:marchAgenda.id,scope:"future",expectedUpdatedAt:marchAgenda.updatedAt,expectedSeriesVersion:state.series.find(row=>row.id===firstId).version,title:"Task 12 later segment",notes:"Later brief"});
    check(record,"later recurring umoor segment accepted",laterAgendaEdit.status===200,"policy-pass",{status:laterAgendaEdit.status});
    state=(await api(base,"admin")).data;
    const earlierAgenda=state.objects.find(row=>row.kind==="umoor"&&row.parentId===meetings[1].id&&row.title==="Task 12 revised agenda");
    const overrideAgenda=await api(base,"planner",{action:"editRecurringUmoor",umoorId:earlierAgenda.id,scope:"future",expectedUpdatedAt:earlierAgenda.updatedAt,expectedSeriesVersion:state.series.find(row=>row.id===firstId).version,title:"Task 12 unified future agenda",notes:"Unified brief"});
    check(record,"earlier future edit supersedes later segment",overrideAgenda.status===200,"policy-pass",{status:overrideAgenda.status});
    state=(await api(base,"admin")).data;
    check(record,"recurring umoor has one unified copy per later meeting",meetings.slice(1).every(meeting=>state.objects.filter(row=>row.kind==="umoor"&&row.parentId===meeting.id&&row.title==="Task 12 unified future agenda").length===1));
    const target=state.objects.find(row=>row.id===meetings[1].id),series=state.series.find(row=>row.id===firstId);
    const payload={action:"editMashwaraSeries",id:target.id,scope:"future",expectedUpdatedAt:target.updatedAt,expectedSeriesVersion:series.version,title:"Task 12 shifted weekly",startAt:"2027-03-14T15:00:00.000Z",frequency:"weekly",timeZone:"America/Toronto",type:"weekly",ameerId:"p-admin",locationId:"",visibility:"markaz",details:"Shifted to 11 a.m.",status:"planned",seriesEndCount:4,seriesEndDay:null};
    const [change,retry]=await Promise.all([api(base,"planner",payload),api(base,"planner",payload)]);
    check(record,"concurrent series edits give one winner and one conflict",[change.status,retry.status].sort().join(",")==="200,409","policy-pass",{statuses:[change.status,retry.status]});
    state=(await api(base,"admin")).data;meetings=state.objects.filter(row=>row.kind==="mashwara"&&row.data.seriesId===firstId).sort((a,b)=>a.data.occurrence-b.data.occurrence);
    check(record,"future change preserves first occurrence and changes later local time",localDateTimeInput(meetings[0].startAt,"America/Toronto").endsWith("T10:00")&&localDateTimeInput(meetings[1].startAt,"America/Toronto").endsWith("T11:00")&&localDateTimeInput(meetings[3].startAt,"America/Toronto").endsWith("T11:00"));
    const cancelled=await api(base,"admin",{action:"editMashwaraSeries",id:meetings[3].id,scope:"one",expectedUpdatedAt:meetings[3].updatedAt,expectedSeriesVersion:state.series.find(row=>row.id===firstId).version,title:meetings[3].title,startAt:meetings[3].startAt,frequency:"weekly",timeZone:"America/Toronto",type:"weekly",ameerId:"p-admin",locationId:"",visibility:"markaz",details:"Cancelled exception",status:"cancelled",seriesEndCount:4,seriesEndDay:null});
    check(record,"one occurrence cancellation accepted",cancelled.status===200,"policy-pass",{status:cancelled.status});
    state=(await api(base,"admin")).data;
    check(record,"cancelled exception survives readback",state.objects.find(row=>row.id===meetings[3].id)?.status==="cancelled");
    const preserved=state.objects.find(row=>row.kind==="umoor"&&row.parentId===meetings[1].id&&row.title==="Task 12 unified future agenda");
    const decision=await api(base,"admin",{action:"setUmoorOutcome",umoorId:preserved.id,decision:"Keep attributed decision",followUp:"Keep original follow-up",done:false});
    check(record,"series test records a meeting decision",decision.status===200);
    state=(await api(base,"admin")).data;
    const second=state.objects.find(row=>row.id===meetings[1].id),currentSeries=state.series.find(row=>row.id===firstId);
    const protectEdit=await api(base,"admin",{...payload,expectedUpdatedAt:second.updatedAt,expectedSeriesVersion:currentSeries.version,startAt:"2027-03-14T16:00:00.000Z",details:"Change future but preserve decision"});
    check(record,"future edit with proceedings accepted",protectEdit.status===200,"policy-pass",{status:protectEdit.status});
    state=(await api(base,"admin")).data;
    check(record,"decision and cancelled exception remain untouched",state.objects.find(row=>row.id===meetings[1].id)?.startAt===second.startAt&&state.objects.find(row=>row.id===preserved.id)?.data.decision==="Keep attributed decision"&&state.objects.find(row=>row.id===meetings[3].id)?.status==="cancelled");
    check(record,"unprotected later meeting takes future change",localDateTimeInput(state.objects.find(row=>row.id===meetings[2].id)?.startAt,"America/Toronto").endsWith("T12:00"));
    const denied=await api(base,"member",{...payload,expectedUpdatedAt:second.updatedAt,expectedSeriesVersion:currentSeries.version});
    check(record,"ordinary member series edit denied",denied.status===403,"policy-pass",{status:denied.status});
    const monthly=await api(base,"admin",{action:"createMashwara",title:"Task 12 month-end",startAt:"2027-01-31T18:00:00.000Z",timeZone:"UTC",recurrence:"monthly",seriesEndCount:4,ameerId:"p-admin"});
    check(record,"monthly series created",monthly.status===200&&monthly.data.occurrences===4,"policy-pass",{status:monthly.status,data:monthly.data});
    state=(await api(base,"admin")).data;
    check(record,"Jan 31 monthly series includes February and March 31",state.objects.filter(row=>row.kind==="mashwara"&&row.data.seriesId===monthly.data.id).sort((a,b)=>a.data.occurrence-b.data.occurrence).map(row=>row.startAt.slice(0,10)).join(",")==="2027-01-31,2027-02-28,2027-03-31,2027-04-30");
    const february=state.objects.find(row=>row.kind==="mashwara"&&row.data.seriesId===monthly.data.id&&row.data.occurrence===2);
    const monthEdit=await api(base,"admin",{action:"editMashwaraSeries",id:february.id,scope:"future",expectedUpdatedAt:february.updatedAt,expectedSeriesVersion:state.series.find(row=>row.id===monthly.data.id).version,title:"Task 12 month-end revised",startAt:"2027-02-28T19:00:00.000Z",frequency:"monthly",timeZone:"UTC",type:"general",ameerId:"p-admin",locationId:"",visibility:"markaz",details:"New time, same month-end rule",status:"planned",seriesEndCount:4,seriesEndDay:null});
    check(record,"future edit from clamped February accepted",monthEdit.status===200,"policy-pass",{status:monthEdit.status});
    state=(await api(base,"admin")).data;
    const monthRows=state.objects.filter(row=>row.kind==="mashwara"&&row.data.seriesId===monthly.data.id).sort((a,b)=>a.data.occurrence-b.data.occurrence);
    check(record,"future month-end edit returns to March 31",monthRows.map(row=>row.startAt.slice(0,16)).join(",")==="2027-01-31T18:00,2027-02-28T19:00,2027-03-31T19:00,2027-04-30T19:00");
    const until=await api(base,"admin",{action:"createMashwara",title:"Task 12 until limit",startAt:"2026-10-02T18:00:00.000Z",timeZone:"UTC",recurrence:"weekly",seriesEndDay:"2026-10-16",ameerId:"p-admin"});
    check(record,"inclusive end day limits generated meetings",until.status===200&&until.data.occurrences===3,"policy-pass",{status:until.status,data:until.data});
    const invalid=await api(base,"admin",{action:"createMashwara",title:"Task 12 invalid end",startAt:"2027-01-31T18:00:00.000Z",timeZone:"UTC",recurrence:"monthly",seriesEndDay:"2027-01-30",ameerId:"p-admin"});
    check(record,"end before first meeting rejected",invalid.status===400,"policy-pass",{status:invalid.status});
    const long=await api(base,"admin",{action:"createMashwara",title:"Task 12 rolling",startAt:"2026-09-01T17:00:00.000Z",timeZone:"UTC",recurrence:"weekly",ameerId:"p-admin"});
    check(record,"unbounded series created",long.status===200,"policy-pass",{status:long.status});
    await Promise.all([api(base,"admin"),api(base,"admin")]);
    state=(await api(base,"admin")).data;
    const rolling=state.objects.filter(row=>row.kind==="mashwara"&&row.data.seriesId===long.data.id);
    check(record,"rolling series continues beyond twelve without duplicate positions",rolling.length>12&&new Set(rolling.map(row=>row.data.occurrence)).size===rolling.length,"policy-pass",{count:rolling.length});
    check(record,"legacy copied meetings retained with original details",state.objects.find(row=>row.id==="mashwara-public")?.data.details==="Review weekend arrangements."&&state.objects.find(row=>row.id==="mashwara-public-next")?.data.details==="Next recurring occurrence.");
    const legacyGenerated=state.objects.find(row=>row.kind==="mashwara"&&row.data.seriesId==="mashwara-public"&&row.data.occurrence===3);
    check(record,"legacy recurring umoor template reaches generated meeting",!!legacyGenerated&&state.objects.some(row=>row.kind==="umoor"&&row.parentId===legacyGenerated.id&&row.title==="Weekend route and Khidmah"&&row.data.recurring===true));
    const vancouver=await api(base,"admin",{action:"createMashwara",title:"Task 12 Vancouver permanent Pacific",startAt:"2026-10-03T03:00:00.000Z",timeZone:"America/Vancouver",recurrence:"weekly",seriesEndCount:10,ameerId:"p-admin"});
    check(record,"Vancouver series created",vancouver.status===200,"policy-pass",{status:vancouver.status});
    state=(await api(base,"admin")).data;
    const november=state.objects.find(row=>row.kind==="mashwara"&&row.data.seriesId===vancouver.data.id&&row.data.occurrence===9);
    check(record,"Worker keeps 8 p.m. after B.C. permanent-time change",november?.startAt==="2026-11-28T03:00:00.000Z"&&localDateTimeInput(november.startAt,"America/Vancouver")==="2026-11-27T20:00","policy-pass",{instant:november?.startAt});
  });
}
async function mashwaraReview(){
  await session("Task 13 Mashwara collaboration",async(base,record)=>{
    let state=(await api(base,"admin")).data;
    check(record,"invalid historical duties queued and retained",["task13-legacy-outsider","task13-legacy-date"].every(id=>state.repairReviews.some(row=>["legacy-assignment","invalid-assignment"].includes(row.kind)&&row.targetId===id)&&state.objects.some(row=>row.id===id)),"policy-pass",{reviews:state.repairReviews.filter(row=>row.targetId.startsWith("task13-legacy"))});
    check(record,"out-of-trip duty denied",(await api(base,"admin",{action:"createItem",kind:"assignment",parentId:"jamaat-weekend",title:"Khidmah",data:{amal:"Khidmah",date:"2026-10-05",personId:"p-member"}})).status===400);
    check(record,"nonmember duty denied",(await api(base,"admin",{action:"createItem",kind:"assignment",parentId:"jamaat-weekend",title:"Khidmah",data:{amal:"Khidmah",date:"2026-10-02",personId:"p-outsider"}})).status===400);
    const valid=await api(base,"admin",{action:"createItem",kind:"assignment",parentId:"jamaat-weekend",title:"Khidmah",data:{amal:"Khidmah",date:"2026-10-02",personId:"p-member"}});
    check(record,"valid current duty accepted",valid.status===200);
    check(record,"generic duty edit enforces trip day",(await versionedEdit(base,"admin",{action:"updateItem",id:valid.data.id,data:{date:"2026-10-05"}})).status===400);
    const outsiderReview=state.repairReviews.find(row=>row.targetId==="task13-legacy-outsider"),dateReview=state.repairReviews.find(row=>row.targetId==="task13-legacy-date");
    const outsiderDuty=state.objects.find(row=>row.id==="task13-legacy-outsider"),dateDuty=state.objects.find(row=>row.id==="task13-legacy-date");
    check(record,"generic edit cannot bypass unresolved duty review",(await versionedEdit(base,"admin",{action:"updateItem",id:dateDuty.id,data:{date:"2026-10-03"}})).status===409);
    check(record,"ordinary member cannot resolve historical duty",(await api(base,"member",{action:"repairLegacyAssignment",reviewId:outsiderReview.id,expectedUpdatedAt:outsiderDuty.updatedAt,resolution:"correct",date:"2026-10-02",personId:"p-member"})).status===403);
    const corrected=await api(base,"admin",{action:"repairLegacyAssignment",reviewId:outsiderReview.id,expectedUpdatedAt:outsiderDuty.updatedAt,resolution:"correct",date:"2026-10-02",personId:"p-member"});
    const historical=await api(base,"admin",{action:"repairLegacyAssignment",reviewId:dateReview.id,expectedUpdatedAt:dateDuty.updatedAt,resolution:"retain-history"});
    state=(await api(base,"admin")).data;
    check(record,"legacy duty review corrects or retains without deleting records",corrected.status===200&&historical.status===200&&state.objects.find(row=>row.id==="task13-legacy-outsider")?.data.personId==="p-member"&&state.objects.find(row=>row.id==="task13-legacy-date")?.status==="historical"&&!state.repairReviews.some(row=>row.targetId.startsWith("task13-legacy")),"policy-pass",{statuses:[corrected.status,historical.status]});
    const meeting=await api(base,"admin",{action:"createMashwara",title:"Task 13 general",type:"general",startAt:"2026-10-10T20:00:00.000Z",timeZone:"UTC",recurrence:"none",ameerId:"p-admin",visibility:"markaz",details:"Initial"});
    check(record,"general Mashwara created",meeting.status===200);
    const meetingId=meeting.data.id;
    const joins=await Promise.all([api(base,"member",{action:"joinMashwara",mashwaraId:meetingId}),api(base,"member",{action:"joinMashwara",mashwaraId:meetingId})]);
    state=(await api(base,"admin")).data;
    check(record,"concurrent Join has one active attendee",joins.every(row=>row.status===200)&&state.objects.filter(row=>row.kind==="attendee"&&row.parentId===meetingId&&row.data.personId==="p-member"&&row.status!=="removed").length===1);
    check(record,"Join retry idempotent",(await api(base,"member",{action:"joinMashwara",mashwaraId:meetingId})).data.existing===true);
    check(record,"Leave clears joined state",(await api(base,"member",{action:"leaveMashwara",mashwaraId:meetingId})).status===200&&!(await api(base,"member")).data.objects.some(row=>row.kind==="attendee"&&row.parentId===meetingId&&row.data.personId==="p-member"&&row.status!=="removed"));
    check(record,"Rejoin restores one active attendee",(await api(base,"member",{action:"joinMashwara",mashwaraId:meetingId})).status===200&&(await api(base,"admin")).data.objects.filter(row=>row.kind==="attendee"&&row.parentId===meetingId&&row.data.personId==="p-member"&&row.status!=="removed").length===1);
    const suggestion=await api(base,"member",{action:"suggestUmoor",mashwaraId:meetingId,title:"Discuss transport",note:"Drivers need confirmation"});
    check(record,"member submits suggestion",suggestion.status===200);
    state=(await api(base,"admin")).data;
    const suggested=state.objects.find(row=>row.kind==="suggestion"&&row.parentId===meetingId&&row.title==="Discuss transport");
    check(record,"nonplanner cannot review suggestion",(await api(base,"member",{action:"reviewSuggestion",suggestionId:suggested.id,expectedUpdatedAt:suggested.updatedAt,decision:"accept"})).status===403);
    const accepted=await api(base,"admin",{action:"reviewSuggestion",suggestionId:suggested.id,expectedUpdatedAt:suggested.updatedAt,decision:"accept",rationale:"Needed for weekend route"});
    state=(await api(base,"admin")).data;
    const agenda=state.objects.find(row=>row.kind==="umoor"&&row.parentId===meetingId&&row.data.suggestionId===suggested.id);
    check(record,"acceptance creates one agenda with rationale",accepted.status===200&&!!agenda&&state.objects.find(row=>row.id===suggested.id)?.data.reviewRationale==="Needed for weekend route");
    check(record,"accept retry conflicts without duplicate",(await api(base,"admin",{action:"reviewSuggestion",suggestionId:suggested.id,expectedUpdatedAt:suggested.updatedAt,decision:"accept"})).status===409&&(await api(base,"admin")).data.objects.filter(row=>row.kind==="umoor"&&row.data.suggestionId===suggested.id).length===1);
    const rejectedSuggestion=await api(base,"member",{action:"suggestUmoor",mashwaraId:meetingId,title:"Unrelated topic",note:"Can wait"});
    state=(await api(base,"admin")).data;
    const rejectedRow=state.objects.find(row=>row.kind==="suggestion"&&row.parentId===meetingId&&row.title==="Unrelated topic");
    check(record,"planner rejects suggestion with no agenda copy",rejectedSuggestion.status===200&&(await api(base,"admin",{action:"reviewSuggestion",suggestionId:rejectedRow.id,expectedUpdatedAt:rejectedRow.updatedAt,decision:"reject",rationale:"Separate meeting"})).status===200&&!(await api(base,"admin")).data.objects.some(row=>row.kind==="umoor"&&row.data.suggestionId===rejectedRow.id));
    const follow=await api(base,"admin",{action:"createFollowUp",umoorId:agenda.id,title:"Confirm driver",ownerId:"p-member",dueDay:"2026-10-11",notes:"Call before departure"});
    state=(await api(base,"member")).data;
    const task=state.objects.find(row=>row.id===follow.data.id);
    check(record,"owner sees assigned follow-up",follow.status===200&&task?.data.ownerId==="p-member"&&task?.data.dueDay==="2026-10-11");
    check(record,"unrelated person cannot complete follow-up",(await api(base,"outsider",{action:"completeFollowUp",followUpId:task.id,expectedUpdatedAt:task.updatedAt,done:true})).status===403);
    check(record,"owner completion attributed",(await api(base,"member",{action:"completeFollowUp",followUpId:task.id,expectedUpdatedAt:task.updatedAt,done:true})).status===200&&(await api(base,"admin")).data.objects.find(row=>row.id===task.id)?.data.completedBy==="p-member");
    check(record,"stale follow-up conflicts",(await api(base,"member",{action:"completeFollowUp",followUpId:task.id,expectedUpdatedAt:task.updatedAt,done:false})).status===409);
    state=(await api(base,"admin")).data;
    const currentAgenda=state.objects.find(row=>row.id===agenda.id);
    const outcomes=await Promise.all([api(base,"admin",{action:"setUmoorOutcome",umoorId:agenda.id,expectedUpdatedAt:currentAgenda.updatedAt,decision:"Plan A",followUp:"",done:false}),api(base,"admin",{action:"setUmoorOutcome",umoorId:agenda.id,expectedUpdatedAt:currentAgenda.updatedAt,decision:"Plan B",followUp:"",done:false})]);
    check(record,"concurrent decisions conflict",outcomes.map(row=>row.status).sort().join(",")==="200,409","policy-pass",{statuses:outcomes.map(row=>row.status)});
    const fresh=(await api(base,"admin")).data.objects.find(row=>row.id===meetingId);
    const setting=await api(base,"admin",{action:"editMashwaraSettings",id:meetingId,expectedUpdatedAt:fresh.updatedAt,title:"Task 13 general revised",startAt:"2026-10-10T21:00:00.000Z",type:"general",ameerId:"p-admin",locationId:"",visibility:"markaz",details:"Revised planning",status:"completed"});
    state=(await api(base,"admin")).data;
    check(record,"settings save and preserve proceedings",setting.status===200&&state.objects.find(row=>row.id===meetingId)?.status==="completed"&&state.objects.find(row=>row.id===agenda.id)?.data.decision&&state.objects.find(row=>row.id===task.id)?.status==="done");
    check(record,"stale meeting settings conflict",(await api(base,"admin",{action:"editMashwaraSettings",id:meetingId,expectedUpdatedAt:fresh.updatedAt,title:"Stale",startAt:"2026-10-10T22:00:00.000Z",type:"general",ameerId:"p-admin",locationId:"",visibility:"markaz",details:"",status:"planned"})).status===409);
    check(record,"ordinary member cannot change meeting settings",(await api(base,"member",{action:"editMashwaraSettings",id:meetingId,expectedUpdatedAt:fresh.updatedAt,title:"Denied",startAt:"2026-10-10T22:00:00.000Z",type:"general",ameerId:"p-admin",locationId:"",visibility:"markaz",details:"",status:"planned"})).status===403);
    const typeRows=await Promise.all([["weekly","weekly"],["halaqa","none"],["national","none"]].map(async([type,recurrence])=>api(base,"admin",{action:"createMashwara",title:`Task 13 ${type}`,type,startAt:"2026-10-12T20:00:00.000Z",timeZone:"UTC",recurrence,seriesEndCount:recurrence==="weekly"?2:null,ameerId:"p-admin",visibility:"markaz",details:"Optional planning"})));
    check(record,"weekly, Halaqa and national-labelled meetings save",typeRows.every(row=>row.status===200),"policy-pass",{statuses:typeRows.map(row=>row.status)});
    const daily=await api(base,"admin",{action:"createDailyMashwara",jamaatId:"jamaat-weekend",date:"2026-10-02",ameerId:"p-ameer"});
    state=(await api(base,"admin")).data;
    const dailyRows=state.objects.filter(row=>row.kind==="umoor"&&row.parentId===daily.data.id&&row.data.builtin===true);
    check(record,"daily plan has eleven templates and excludes legacy outsider",daily.status===200&&dailyRows.length===11&&!dailyRows.some(row=>Array.isArray(row.data.personIds)&&row.data.personIds.includes("p-outsider")));
    const saturday=await api(base,"admin",{action:"createDailyMashwara",jamaatId:"jamaat-weekend",date:"2026-10-03",ameerId:"p-ameer"});
    const sunday=await api(base,"admin",{action:"createDailyMashwara",jamaatId:"jamaat-weekend",date:"2026-10-04",ameerId:"p-ameer"});
    check(record,"three daily plans save on three trip days",saturday.status===200&&sunday.status===200&&(await api(base,"admin")).data.objects.filter(row=>row.kind==="mashwara"&&row.data.daily===true&&row.parentId==="jamaat-weekend").length===3);
    const khidmah=dailyRows.find(row=>row.title==="Khidmah"),fajr=dailyRows.find(row=>row.title.includes("Fajr")),bayaan=dailyRows.find(row=>row.title.includes("Bayaan"));
    check(record,"daily templates include Khidmah, Fajr and Bayaan",!!khidmah&&!!fajr&&!!bayaan);
    const khidmahPlan=await api(base,"admin",{action:"setDailyAmal",umoorId:khidmah.id,active:true,personIds:["p-member","p-ameer"],notes:"Two helpers"});
    const fajrPlan=await api(base,"admin",{action:"setDailyAmal",umoorId:fajr.id,active:true,personIds:[],notes:"Assign later"});
    const bayaanSkip=await api(base,"admin",{action:"setDailyAmal",umoorId:bayaan.id,active:false,personIds:[],notes:"Not planned today"});
    state=(await api(base,"admin")).data;
    check(record,"two Khidmah helpers and unassigned Fajr persist while Bayaan stays skipped",khidmahPlan.status===200&&fajrPlan.status===200&&bayaanSkip.status===200&&state.objects.find(row=>row.id===khidmah.id)?.data.personIds.length===2&&state.objects.find(row=>row.id===fajr.id)?.data.active===true&&state.objects.find(row=>row.id===fajr.id)?.data.personIds.length===0&&state.objects.find(row=>row.id===bayaan.id)?.data.active===false);
    const mastooraat=await api(base,"admin",{action:"createDailyMashwara",jamaatId:"jamaat-mastooraat",date:"2026-10-02",ameerId:"p-ameer"});
    check(record,"Mastooraat daily plan has sixteen optional items",mastooraat.status===200&&(await api(base,"admin")).data.objects.filter(row=>row.kind==="umoor"&&row.parentId===mastooraat.data.id&&row.data.builtin===true).length===16,"policy-pass",{status:mastooraat.status});
    check(record,"daily Ameer must be Jamaat member",(await api(base,"admin",{action:"editMashwaraSettings",id:daily.data.id,expectedUpdatedAt:state.objects.find(row=>row.id===daily.data.id).updatedAt,title:"Daily",ameerId:"p-outsider",locationId:"",details:"",status:"planned"})).status===400);
  },"audit/repair-task-13-legacy-fixture.sql");
}
async function ijtemaReview(){
  await session("Task 14 Ijtema team duties",async(base,record)=>{
    const event=await api(base,"admin",{action:"createItem",kind:"event",title:"Task 14 Ijtema",startAt:"2026-10-04",endAt:"2026-10-04",data:{type:"Ijtema",details:"Community service"}});
    check(record,"Markaz creates Ijtema",event.status===200);
    const team=await api(base,"admin",{action:"createItem",kind:"team",parentId:event.data.id,title:"Hospitality",data:{personId:"p-team-ameer",details:"Prepare arrivals"}});
    check(record,"Markaz appoints team Ameer",team.status===200);
    const otherTeam=await api(base,"admin",{action:"createItem",kind:"team",parentId:event.data.id,title:"Transport",data:{personId:"p-outsider",details:"Arrange rides"}});
    check(record,"second team has separate Ameer",otherTeam.status===200);
    const teamState=(await api(base,"team-ameer")).data;
    check(record,"team Ameer sees team and responsible names",teamState.objects.some(row=>row.id===team.data.id)&&teamState.people.some(row=>row.id==="p-duty-member"&&row.name&&row.phone===null&&row.email===null));
    const teamBefore=teamState.objects.find(row=>row.id===team.data.id);
    const teamEdit=await api(base,"team-ameer",{action:"editEventTeam",teamId:team.data.id,expectedUpdatedAt:teamBefore.updatedAt,title:"Hospitality",details:"Set up welcome table"});
    check(record,"team Ameer updates own instructions",teamEdit.status===200&&(await api(base,"admin")).data.objects.find(row=>row.id===team.data.id)?.data.details==="Set up welcome table");
    check(record,"team Ameer cannot appoint self elsewhere",(await api(base,"team-ameer",{action:"editEventTeam",teamId:otherTeam.data.id,expectedUpdatedAt:(await api(base,"admin")).data.objects.find(row=>row.id===otherTeam.data.id).updatedAt,title:"Transport",details:"Hijack",personId:"p-team-ameer"})).status===403);
    check(record,"team Ameer cannot change own appointment",(await api(base,"team-ameer",{action:"editEventTeam",teamId:team.data.id,expectedUpdatedAt:(await api(base,"admin")).data.objects.find(row=>row.id===team.data.id).updatedAt,title:"Hospitality",details:"",personId:"p-outsider"})).status===403);
    const candidate=await api(base,"team-ameer",undefined,{path:`/api/app?candidateParentId=${team.data.id}&q=Adam`});
    check(record,"team Ameer can search candidate names without contacts",candidate.status===200&&candidate.data.candidates.some(row=>row.id==="p-duty-member"&&row.name&&!Object.hasOwn(row,"phone")));
    check(record,"unrelated team candidate search denied",(await api(base,"team-ameer",undefined,{path:`/api/app?candidateParentId=${otherTeam.data.id}&q=Adam`})).status===403);
    check(record,"team Ameer cannot create duty in unrelated team",(await api(base,"team-ameer",{action:"createItem",kind:"duty",parentId:otherTeam.data.id,title:"Forged assignment",data:{personId:"p-duty-member",details:""}})).status===403);
    check(record,"team Ameer cannot create duty under forged ID",(await api(base,"team-ameer",{action:"createItem",kind:"duty",parentId:"team-other-markaz",title:"Forged assignment",data:{personId:"p-duty-member",details:""}})).status===404);
    check(record,"duty due time outside event is rejected",(await api(base,"team-ameer",{action:"createItem",kind:"duty",parentId:team.data.id,title:"Late duty",data:{personId:"p-duty-member",details:"",dueAt:"2026-10-05T14:00:00-07:00"}})).status===400);
    const requestId="11111111-2222-4333-8444-555555555555";
    const createBody={action:"createItem",kind:"duty",parentId:team.data.id,requestId,title:"Welcome guests",data:{personId:"p-duty-member",details:"Open entrance and greet guests",dueAt:"2026-10-04T14:00:00-07:00"}};
    const created=await api(base,"team-ameer",createBody);
    const repeated=await api(base,"team-ameer",createBody);
    const dutyId=created.data.id;
    check(record,"team Ameer assigns one detailed duty with idempotent retry",created.status===200&&repeated.status===200&&repeated.data.existing===true&&dutyId===repeated.data.id&&(await api(base,"admin")).data.objects.filter(row=>row.id===dutyId).length===1);
    check(record,"reusing request ID with different duty is rejected",(await api(base,"team-ameer",{...createBody,title:"Different duty"})).status===409);
    const concurrentBody={...createBody,requestId:"44444444-2222-4333-8444-555555555555",title:"Prepare signage",data:{personId:"p-duty-member",details:"At entrance",dueAt:"2026-10-04T15:00:00-07:00"}};
    const concurrentCreate=await Promise.all([api(base,"team-ameer",concurrentBody),api(base,"team-ameer",concurrentBody)]);
    check(record,"concurrent duplicate duty request leaves one row",concurrentCreate.every(row=>row.status===200)&&concurrentCreate.some(row=>row.data.existing===true)&&(await api(base,"admin")).data.objects.filter(row=>row.id===concurrentCreate[0].data.id).length===1,"policy-pass",{statuses:concurrentCreate.map(row=>row.status)});
    const memberState=(await api(base,"duty-member")).data;
    const duty=memberState.objects.find(row=>row.id===dutyId);
    check(record,"assignee sees duty, due time and team Ameer name without contacts",duty?.data.dueAt&&memberState.people.some(row=>row.id==="p-team-ameer"&&row.name&&row.phone===null&&row.email===null));
    check(record,"unrelated member cannot edit duty",(await api(base,"member",{action:"saveEventDuty",dutyId,expectedUpdatedAt:duty.updatedAt,status:"done"})).status===403);
    check(record,"assignee cannot rewrite instructions",(await api(base,"duty-member",{action:"saveEventDuty",dutyId,expectedUpdatedAt:duty.updatedAt,status:"done",details:"Changed"})).status===403);
    check(record,"forged cross-tenant duty ID unavailable",(await api(base,"team-ameer",{action:"saveEventDuty",dutyId:"jamaat-other",expectedUpdatedAt:"x",status:"done"})).status===404);
    const progress=await api(base,"duty-member",{action:"saveEventDuty",dutyId,expectedUpdatedAt:duty.updatedAt,status:"in-progress"});
    check(record,"assignee records progress with attribution",progress.status===200&&(await api(base,"admin")).data.objects.find(row=>row.id===dutyId)?.data.progressBy==="p-duty-member");
    check(record,"repeat stale save conflicts",(await api(base,"duty-member",{action:"saveEventDuty",dutyId,expectedUpdatedAt:duty.updatedAt,status:"done"})).status===409);
    const current=(await api(base,"admin")).data.objects.find(row=>row.id===dutyId);
    const race=await Promise.all([api(base,"team-ameer",{action:"saveEventDuty",dutyId,expectedUpdatedAt:current.updatedAt,status:"done"}),api(base,"duty-member",{action:"saveEventDuty",dutyId,expectedUpdatedAt:current.updatedAt,status:"done"})]);
    check(record,"concurrent completion gives one winner and one conflict",race.map(row=>row.status).sort().join(",")==="200,409","policy-pass",{statuses:race.map(row=>row.status)});
    const reassignment=(await api(base,"admin")).data.objects.find(row=>row.id===dutyId);
    const changed=await api(base,"team-ameer",{action:"saveEventDuty",dutyId,expectedUpdatedAt:reassignment.updatedAt,status:"open",personId:"p-member",title:"Welcome guests",details:"New shift",dueAt:"2026-10-04T15:00:00-07:00"});
    check(record,"team Ameer reassigns duty",changed.status===200&&(await api(base,"admin")).data.objects.find(row=>row.id===dutyId)?.data.personId==="p-member");
    const afterChange=(await api(base,"admin")).data.objects.find(row=>row.id===dutyId);
    check(record,"former assignee loses progress authority",(await api(base,"duty-member",{action:"saveEventDuty",dutyId,expectedUpdatedAt:afterChange.updatedAt,status:"done"})).status===403);
    check(record,"new assignee completes duty",(await api(base,"member",{action:"saveEventDuty",dutyId,expectedUpdatedAt:afterChange.updatedAt,status:"done"})).status===200);
    const teamFresh=(await api(base,"admin")).data.objects.find(row=>row.id===team.data.id);
    check(record,"Markaz can replace team Ameer",(await api(base,"admin",{action:"editEventTeam",teamId:team.data.id,expectedUpdatedAt:teamFresh.updatedAt,title:"Hospitality",details:"New leader",personId:"p-outsider"})).status===200);
    check(record,"former team Ameer loses duty creation",(await api(base,"team-ameer",{...createBody,requestId:"22222222-2222-4333-8444-555555555555"})).status===403);
    const next=await api(base,"outsider",{...createBody,requestId:"33333333-2222-4333-8444-555555555555",title:"Close entrance",data:{personId:"p-duty-member",details:"After guests enter",dueAt:"2026-10-04T16:00:00-07:00"}});
    check(record,"new team Ameer can assign own duty",next.status===200);
    const eventBefore=(await api(base,"admin")).data.objects.find(row=>row.id===event.data.id);
    check(record,"event completion waits for open duty",(await versionedEdit(base,"admin",{action:"updateItem",id:event.data.id,status:"completed"})).status===409);
    const nextDuty=(await api(base,"admin")).data.objects.find(row=>row.id===next.data.id);
    check(record,"second assignee completes duty",(await api(base,"duty-member",{action:"saveEventDuty",dutyId:next.data.id,expectedUpdatedAt:nextDuty.updatedAt,status:"done"})).status===200);
    const duplicateDuty=(await api(base,"admin")).data.objects.find(row=>row.id===concurrentCreate[0].data.id);
    check(record,"duplicate-request duty also completed",(await api(base,"duty-member",{action:"saveEventDuty",dutyId:duplicateDuty.id,expectedUpdatedAt:duplicateDuty.updatedAt,status:"done"})).status===200);
    check(record,"Markaz closes finished event",(await versionedEdit(base,"admin",{action:"updateItem",id:event.data.id,status:"completed"})).status===200);
    const completed=(await api(base,"admin")).data.objects.find(row=>row.id===next.data.id);
    check(record,"completed event freezes duties",(await api(base,"outsider",{action:"saveEventDuty",dutyId:next.data.id,expectedUpdatedAt:completed.updatedAt,status:"open"})).status===409);
    check(record,"completed event ends team candidate search",(await api(base,"outsider",undefined,{path:`/api/app?candidateParentId=${team.data.id}&q=Adam`})).status===403);
    check(record,"legacy generic duty edit cannot bypass controls",(await versionedEdit(base,"admin",{action:"updateItem",id:dutyId,status:"open"})).status===409);
  });
}
async function barakaReview(){
  await session("Task 15 Baraka ledger",async(base,record)=>{
    const view=persona=>api(base,persona);
    const moneyRows=async()=>((await view("admin")).data.objects.filter(row=>row.kind==="money"&&row.parentId==="jamaat-weekend"));
    const balance=rows=>rows.reduce((sum,row)=>sum+(ledgerDelta(row.data.type,row.data.amountCents)||0),0);
    const before=await moneyRows();
    check(record,"historical invalid amount retained and queued",before.some(row=>row.id==="legacy-invalid-money")&&(await view("admin")).data.repairReviews.some(row=>row.targetId==="legacy-invalid-money"&&row.kind==="invalid-baraka"));
    check(record,"legacy invalid amount excluded from starting balance",balance(before)===8750,"policy-pass",{balance:balance(before)});
    const make=(key,amountCents,title="Task 15 collection",type="collection")=>({action:"createItem",kind:"money",parentId:"jamaat-weekend",idempotencyKey:key,title,data:{type,amountCents,currency:"CAD",date:"2026-10-02",note:"Synthetic ledger entry",reference:`R-${key}`}});
    const one=await api(base,"ameer",make("baraka-one-cent",1,"One cent"));
    const twelve=await api(base,"ameer",make("baraka-twelve-fifty",1250,"Twelve fifty"));
    check(record,"one cent and twelve fifty recorded exactly",one.status===200&&twelve.status===200&&(await moneyRows()).find(row=>row.id===one.data.id)?.data.amountCents===1&&(await moneyRows()).find(row=>row.id===twelve.data.id)?.data.amountCents===1250);
    check(record,"new entries store CAD and receipt reference",(await moneyRows()).filter(row=>[one.data.id,twelve.data.id].includes(row.id)).every(row=>row.data.currency==="CAD"&&String(row.data.reference).startsWith("R-")));
    check(record,"missing stable key rejected",(await api(base,"ameer",{action:"createItem",kind:"money",parentId:"jamaat-weekend",title:"No key",data:{type:"collection",amountCents:100,date:"2026-10-02"}})).status===400);
    for(const [name,value] of [["boolean",true],["array",[250]],["fractional",12.5],["zero",0],["negative",-1]])check(record,`${name} cents rejected`,(await api(base,"ameer",make(`bad-${name}-amount`,value))).status===400);
    check(record,"unsupported currency rejected",(await api(base,"ameer",{...make("bad-currency-entry",250),data:{...make("bad-currency-entry",250).data,currency:"USD"}})).status===400);
    check(record,"invalid local day rejected",(await api(base,"ameer",{...make("bad-day-entry",250),data:{...make("bad-day-entry",250).data,date:"2026-02-30"}})).status===400);
    const recovered=await api(base,"ameer",make("bad-zero-amount",200,"Recovered after validation"));
    check(record,"invalid save leaves key usable for corrected retry",recovered.status===200);
    const repeat=await api(base,"ameer",make("baraka-twelve-fifty",1250,"Twelve fifty"));
    check(record,"sequential retry returns original entry",repeat.status===200&&repeat.data.existing===true&&repeat.data.id===twelve.data.id);
    check(record,"same key with changed amount conflicts",(await api(base,"ameer",make("baraka-twelve-fifty",1300,"Twelve fifty"))).status===409);
    const parallel=await Promise.all([api(base,"ameer",make("baraka-parallel-one",500,"Parallel same")),api(base,"ameer",make("baraka-parallel-one",500,"Parallel same"))]);
    check(record,"parallel same-key requests create one entry",parallel.every(row=>row.status===200)&&parallel[0].data.id===parallel[1].data.id&&(await moneyRows()).filter(row=>row.id===parallel[0].data.id).length===1,"policy-pass",{statuses:parallel.map(row=>row.status)});
    const independent=await Promise.all([api(base,"ameer",make("baraka-parallel-two",200,"Parallel A")),api(base,"ameer",make("baraka-parallel-three",300,"Parallel B"))]);
    check(record,"independent concurrent entries both persist",independent.every(row=>row.status===200)&&independent[0].data.id!==independent[1].data.id);
    const original=(await moneyRows()).find(row=>row.id===twelve.data.id);
    const correction={action:"correctBaraka",originalId:original.id,expectedUpdatedAt:original.updatedAt,idempotencyKey:"baraka-correct-twelve",mode:"replace",reason:"Receipt showed a different amount",date:"2026-10-03",replacement:{title:"Corrected twelve fifty",type:"collection",amountCents:1200,note:"Correct receipt",reference:"R-corrected"}};
    check(record,"unrelated member cannot correct",(await api(base,"member",correction)).status===403);
    const corrected=await api(base,"ameer",correction);
    const afterCorrect=await moneyRows();
    check(record,"correction retains original and adds reversal plus replacement",corrected.status===200&&afterCorrect.find(row=>row.id===original.id)?.data.amountCents===1250&&afterCorrect.find(row=>row.id===corrected.data.id)?.data.reversalOf===original.id&&afterCorrect.find(row=>row.id===corrected.data.replacementId)?.data.replaces===original.id);
    check(record,"correction reason and attribution retained",afterCorrect.find(row=>row.id===corrected.data.id)?.data.correctionReason==="Receipt showed a different amount"&&afterCorrect.find(row=>row.id===corrected.data.id)?.data.correctionBy==="p-ameer");
    const retried=await api(base,"ameer",correction);
    check(record,"correction retry returns same reversal and replacement",retried.status===200&&retried.data.existing===true&&retried.data.id===corrected.data.id&&retried.data.replacementId===corrected.data.replacementId);
    check(record,"second correction key cannot reverse original again",(await api(base,"ameer",{...correction,idempotencyKey:"baraka-correct-twelve-again"})).status===409);
    check(record,"generic money edit cannot erase original",(await versionedEdit(base,"ameer",{action:"updateItem",id:original.id,data:{note:"Hidden rewrite"}})).status===409);
    const parallelOriginal=(await moneyRows()).find(row=>row.id===parallel[0].data.id);
    const reverseBase={action:"correctBaraka",originalId:parallelOriginal.id,expectedUpdatedAt:parallelOriginal.updatedAt,mode:"reverse",reason:"Collection was entered twice",date:"2026-10-03"};
    const race=await Promise.all([api(base,"ameer",{...reverseBase,idempotencyKey:"baraka-reverse-a"}),api(base,"ameer",{...reverseBase,idempotencyKey:"baraka-reverse-b"})]);
    check(record,"concurrent reversals allow one winner",race.map(row=>row.status).sort().join(",")==="200,409"&&(await moneyRows()).filter(row=>row.data.reversalOf===parallelOriginal.id).length===1,"policy-pass",{statuses:race.map(row=>row.status)});
    const finalRows=await moneyRows();
    check(record,"weekend balance is exact after correction and reversal",balance(finalRows)===10651,"policy-pass",{balance:balance(finalRows)});
    check(record,"ordinary planner sees no ledger rows",!(await view("planner")).data.objects.some(row=>row.kind==="money"));
    check(record,"ordinary planner cannot create or reverse funds",(await api(base,"planner",make("baraka-denied-planner",100))).status===403&&(await api(base,"planner",{...reverseBase,idempotencyKey:"baraka-denied-reversal"})).status===403);
    check(record,"legacy invalid amount cannot be blindly reversed",(await api(base,"admin",{action:"correctBaraka",originalId:"legacy-invalid-money",expectedUpdatedAt:finalRows.find(row=>row.id==="legacy-invalid-money").updatedAt,idempotencyKey:"baraka-invalid-legacy-reverse",mode:"reverse",reason:"Review pending receipt",date:"2026-10-03"})).status===409);
  },"audit/repair-task-03-legacy-fixture.sql");
}
async function recordedReview() {
  await session("Task 16 recorded information",async(base,record)=>{
    const view=persona=>api(base,persona);
    const item=async(id,persona="ameer")=>(await view(persona)).data.objects.find(row=>row.id===id);
    const history=async(id,persona="ameer")=>(await view(persona)).data.recordedRevisions.filter(row=>row.objectId===id);
    const existing=await view("ameer");
    check(record,"existing tashkil intention and follow-up restored",existing.data.objects.find(row=>row.id==="tashkil-weekend")?.data.intention==="3 days next month"&&existing.data.objects.find(row=>row.id==="tashkil-weekend")?.data.followUp==="Ask permission before contact.");
    check(record,"existing handover keeps venue and both note fields",existing.data.objects.find(row=>row.id==="masjid-note-weekend")?.parentId==="place-1"&&existing.data.objects.find(row=>row.id==="masjid-note-weekend")?.data.localWork.includes("Ta'leem")&&existing.data.objects.find(row=>row.id==="masjid-note-weekend")?.data.text==="PRIVATE_MASJID_NOTE_CANARY");
    check(record,"existing incident attribution and follow-up restored",existing.data.objects.find(row=>row.id==="incident-weekend")?.data.reportedBy==="p-ameer"&&existing.data.objects.find(row=>row.id==="incident-weekend")?.data.followUp.includes("transport"));
    const note=await api(base,"ameer",{action:"createItem",kind:"note",parentId:"jamaat-weekend",title:"Return summary",data:{category:"summary",text:"Synthetic weekend return",peopleTashkiled:4,jamaatsTashkiled:2}});
    check(record,"return summary saves exact numeric outcomes",note.status===200&&(await item(note.data.id))?.data.peopleTashkiled===4&&(await item(note.data.id))?.data.jamaatsTashkiled===2);
    const newTashkil=async(context,key)=>api(base,"ameer",{action:"createItem",kind:"tashkil",parentId:"jamaat-weekend",title:`${context} intention`,data:{context,personName:`Synthetic ${key}`,intention:"Three days next month",note:"No contact detail collected",followUp:"Ask again next week",followUpOwnerId:"p-member",followUpDueDay:"2026-10-04",followUpStatus:"open"}});
    const jawla=await newTashkil("Jawla","one"),afterTalk=await newTashkil("Bayaan","two"),general=await newTashkil("General","three");
    const contextRows=await Promise.all([jawla,afterTalk,general].map(row=>item(row.data.id)));
    check(record,"Jawla after-talk and general intentions persist",[jawla,afterTalk,general].every(row=>row.status===200)&&contextRows.map(row=>row?.data.context).join(",")==="Jawla,Bayaan,General");
    check(record,"tashkil follow-up owner due day and state persist",(await item(jawla.data.id))?.data.followUpOwnerId==="p-member"&&(await item(jawla.data.id))?.data.followUpDueDay==="2026-10-04"&&(await item(jawla.data.id))?.data.followUpStatus==="open");
    check(record,"nonmember cannot own tashkil follow-up",(await api(base,"ameer",{action:"createItem",kind:"tashkil",parentId:"jamaat-weekend",title:"Invalid owner",data:{context:"General",intention:"Synthetic",followUpOwnerId:"p-outsider"}})).status===400);
    const handover=await api(base,"ameer",{action:"createItem",kind:"masjid_note",parentId:"place-2",title:"Saturday handover",data:{jamaatId:"jamaat-weekend",localWork:"Synthetic local work conditions",text:"Synthetic other handover notes"}});
    check(record,"handover links correct route venue and Jamaat",handover.status===200&&(await item(handover.data.id))?.parentId==="place-2"&&(await item(handover.data.id))?.data.jamaatId==="jamaat-weekend");
    check(record,"handover stores local conditions and other notes",(await item(handover.data.id))?.data.localWork==="Synthetic local work conditions"&&(await item(handover.data.id))?.data.text==="Synthetic other handover notes");
    check(record,"off-route venue handover rejected",(await api(base,"ameer",{action:"createItem",kind:"masjid_note",parentId:"place-markaz",title:"Wrong venue",data:{jamaatId:"jamaat-weekend",localWork:"Synthetic"}})).status===400);
    const incident=await api(base,"ameer",{action:"createItem",kind:"incident",parentId:"jamaat-weekend",title:"Synthetic incident follow-up",data:{severity:"low",description:"Fictional bicycle repair needed",followUp:"Ask volunteer to inspect"}});
    check(record,"incident saves factual report and actor",incident.status===200&&(await item(incident.data.id))?.data.reportedBy==="p-ameer"&&(await item(incident.data.id))?.status==="open");
    const revise=(row,reason,data,status)=>({action:"reviseRecordedInfo",id:row.id,expectedUpdatedAt:row.updatedAt,title:row.title,reason,data,...(status?{status}:{})});
    const noteBefore=await item(note.data.id);
    const noteUpdate=await api(base,"ameer",revise(noteBefore,"Count confirmed against register",{category:"summary",text:"Corrected synthetic weekend return",peopleTashkiled:5,jamaatsTashkiled:3}));
    check(record,"note correction updates text and numeric outcomes",noteUpdate.status===200&&(await item(note.data.id))?.data.peopleTashkiled===5&&(await item(note.data.id))?.data.jamaatsTashkiled===3);
    check(record,"note original preserved in attributed history",(await history(note.data.id)).some(row=>row.actorId==="p-ameer"&&row.before.data.peopleTashkiled===4&&row.after.data.peopleTashkiled===5&&row.reason==="Count confirmed against register"));
    check(record,"stale note correction conflicts",(await api(base,"ameer",revise(noteBefore,"Stale correction denied",{category:"summary",text:"Old",peopleTashkiled:0,jamaatsTashkiled:0}))).status===409);
    const raceBefore=await item(note.data.id);
    const race=await Promise.all([api(base,"ameer",revise(raceBefore,"Concurrent A correction",{category:"summary",text:"Version A",peopleTashkiled:6,jamaatsTashkiled:3})),api(base,"ameer",revise(raceBefore,"Concurrent B correction",{category:"summary",text:"Version B",peopleTashkiled:7,jamaatsTashkiled:3}))]);
    check(record,"concurrent note corrections allow one winner",race.map(row=>row.status).sort().join(",")==="200,409"&&(await history(note.data.id)).length===2);
    const tashkilBefore=await item(jawla.data.id);
    const complete=await api(base,"ameer",revise(tashkilBefore,"Follow-up completed after conversation",{context:"Jawla",personName:"Synthetic one",intention:"Three days next month",note:"No contact detail collected",followUp:"Spoke again next week",followUpOwnerId:"p-member",followUpDueDay:"2026-10-04",followUpStatus:"done"}));
    check(record,"tashkil follow-up can be completed",complete.status===200&&(await item(jawla.data.id))?.data.followUpStatus==="done");
    const reopen=await api(base,"ameer",revise(await item(jawla.data.id),"Follow-up needs another conversation",{context:"Jawla",personName:"Synthetic one",intention:"Three days next month",note:"No contact detail collected",followUp:"Ask again",followUpOwnerId:"p-member",followUpDueDay:"2026-10-04",followUpStatus:"open"}));
    check(record,"tashkil follow-up can reopen with history",reopen.status===200&&(await item(jawla.data.id))?.data.followUpStatus==="open"&&(await history(jawla.data.id)).length===2);
    const handoverUpdate=await api(base,"ameer",revise(await item(handover.data.id),"Host confirmed both handover details",{jamaatId:"jamaat-weekend",localWork:"Updated local work conditions",text:"Updated other handover notes"}));
    check(record,"handover correction retains both fields and venue",handoverUpdate.status===200&&(await item(handover.data.id))?.parentId==="place-2"&&(await item(handover.data.id))?.data.text==="Updated other handover notes"&&(await history(handover.data.id)).length===1);
    check(record,"handover cannot be reassigned to another Jamaat",(await api(base,"ameer",revise(await item(handover.data.id),"Forged handover reassignment",{jamaatId:"jamaat-pending",localWork:"Wrong",text:"Wrong"}))).status===400);
    const inReview=await api(base,"ameer",revise(await item(incident.data.id),"Reviewing fictional incident",{severity:"moderate",description:"Fictional bicycle repair needed",followUp:"Inspection scheduled"},"in-review"));
    check(record,"incident enters review with follow-up",inReview.status===200&&(await item(incident.data.id))?.status==="in-review");
    check(record,"incident cannot resolve without follow-up",(await api(base,"ameer",revise(await item(incident.data.id),"No resolution recorded",{severity:"moderate",description:"Fictional bicycle repair needed",followUp:""},"resolved"))).status===400);
    const resolved=await api(base,"ameer",revise(await item(incident.data.id),"Fictional repair confirmed",{severity:"moderate",description:"Fictional bicycle repair needed",followUp:"Volunteer confirmed repair"},"resolved"));
    check(record,"incident resolves with attribution and history",resolved.status===200&&(await item(incident.data.id))?.status==="resolved"&&(await item(incident.data.id))?.data.reportedBy==="p-ameer"&&(await history(incident.data.id)).length===2);
    const incidentReopened=await api(base,"ameer",revise(await item(incident.data.id),"Reopened for second safety check",{severity:"moderate",description:"Fictional bicycle repair needed",followUp:"Second check pending"},"open"));
    check(record,"incident reopens without erasing resolution",incidentReopened.status===200&&(await item(incident.data.id))?.status==="open"&&(await history(incident.data.id)).length===3);
    check(record,"generic edits cannot bypass correction history",(await versionedEdit(base,"ameer",{action:"updateItem",id:incident.data.id,data:{followUp:"Unattributed"}})).status===409);
    check(record,"ordinary member cannot read sensitive records or history",!(await view("member")).data.objects.some(row=>["note","tashkil","masjid_note","incident","money"].includes(row.kind))&&(await view("member")).data.recordedRevisions.length===0);
    check(record,"ordinary member cannot revise incident or note",(await api(base,"member",revise(await item(incident.data.id),"Unauthorized incident edit",{severity:"low",description:"Wrong",followUp:"Wrong"},"open"))).status===403&&(await api(base,"member",revise(await item(note.data.id),"Unauthorized note edit",{category:"summary",text:"Wrong",peopleTashkiled:0,jamaatsTashkiled:0}))).status===403);
    check(record,"notes-only scope can be granted",(await api(base,"admin",{action:"setMemberPermission",jamaatId:"jamaat-weekend",personId:"p-planner",scopes:["notes"]})).status===200);
    const notesOnly=await view("planner");
    check(record,"notes-only planner sees notes and handovers but no incident or tashkil",notesOnly.data.objects.some(row=>row.id===note.data.id)&&notesOnly.data.objects.some(row=>row.id===handover.data.id)&&!notesOnly.data.objects.some(row=>[incident.data.id,jawla.data.id].includes(row.id))&&notesOnly.data.recordedRevisions.some(row=>row.objectId===note.data.id)&&!notesOnly.data.recordedRevisions.some(row=>row.objectId===incident.data.id));
    check(record,"notes-only planner cannot revise incident",(await api(base,"planner",revise(await item(incident.data.id),"Wrong incident scope",{severity:"low",description:"Wrong",followUp:"Wrong"},"open"))).status===403);
    check(record,"notes access revocation hides saved content and history",(await api(base,"admin",{action:"revokeMemberPermissions",jamaatId:"jamaat-weekend",personId:"p-planner"})).status===200&&!(await view("planner")).data.objects.some(row=>row.id===note.data.id)&&!(await view("planner")).data.recordedRevisions.some(row=>row.objectId===note.data.id));
    check(record,"cross-tenant incident remains hidden",!(await view("ameer")).data.objects.some(row=>row.id==="incident-other")&&(await api(base,"ameer",{action:"reviseRecordedInfo",id:"incident-other",expectedUpdatedAt:"2026-09-30T00:00:00.000Z",title:"Wrong",reason:"Wrong tenant edit",status:"open",data:{severity:"low",description:"Wrong",followUp:"Wrong"}})).status===404);
  });
}
async function placesReview() {
  await session("Task 17 Places, provenance, and links",async(base,record,{directory,env})=>{
    const runSql=sql=>command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--command",sql],env);
    const candidate={osmId:"node/701",osmIds:["node/701","way/702"],name:"Task 17 Musallah",address:"701 Test Road Surrey",type:"musalla",lat:49.14,lon:-122.82,source:"OpenStreetMap",checkedAt:new Date().toISOString()};
    const expires=new Date(Date.now()+3600000).toISOString();
    runSql(`INSERT INTO directory_candidates VALUES ('node/701','${JSON.stringify(candidate)}','live','${candidate.checkedAt}','${expires}'),('way/702','${JSON.stringify(candidate)}','live','${candidate.checkedAt}','${expires}')`);
    check(record,"ordinary member cannot import directory place",(await api(base,"member",{action:"addOsmPlace",osmId:"node/701"})).status===403);
    check(record,"unknown source identifier rejected",(await api(base,"admin",{action:"addOsmPlace",osmId:"node/999"})).status===409);
    const imported=await api(base,"admin",{action:"addOsmPlace",osmId:"way/702",title:"Spoofed",address:"Fake",lat:1,lon:1,provenance:"verified",hostPermission:"confirmed"});
    check(record,"import uses server candidate and keeps host unconfirmed",imported.status===200,{status:imported.status});
    const importedRow=(await api(base,"admin")).data.objects.find(row=>row.id===imported.data.id);
    check(record,"client provenance and coordinates ignored",importedRow.title===candidate.name&&importedRow.data.address===candidate.address&&importedRow.data.lat===candidate.lat&&importedRow.data.provenance==="server-checked"&&importedRow.data.hostPermission==="unknown"&&importedRow.data.type==="musalla");
    const otherTenant=await api(base,"other-admin");
    check(record,"imported venue stays in its Markaz",!otherTenant.data.objects.some(row=>row.id===imported.data.id)&&(await versionedEdit(base,"other-admin",{action:"updateItem",id:imported.data.id,title:"Wrong tenant",data:{type:"masjid"}})).status===404);
    const adminProfile=await api(base,"admin");
    check(record,"local and national Markaz preferences stay distinct",adminProfile.data.me.localMarkazId==="place-markaz"&&adminProfile.data.me.nationalMarkazId==="place-national");
    check(record,"node alias blocked after way import",(await api(base,"admin",{action:"addOsmPlace",osmId:"node/701"})).status===409);
    const saved={...candidate,osmId:"node/705",osmIds:["node/705"],name:"Saved Snapshot Centre",address:"705 Example Avenue Surrey"};
    runSql(`INSERT INTO directory_candidates VALUES ('node/705','${JSON.stringify(saved)}','snapshot','2026-09-30T00:00:00.000Z','${expires}')`);
    const snapshotImport=await api(base,"admin",{action:"addOsmPlace",osmId:"node/705",provenance:"live"});
    const snapshotRow=(await api(base,"admin")).data.objects.find(row=>row.id===snapshotImport.data.id);
    check(record,"snapshot import remains explicitly unverified",snapshotImport.status===200&&snapshotRow.data.provenance==="snapshot-unverified"&&snapshotRow.data.hostPermission==="unknown");
    const far={...candidate,osmId:"node/703",osmIds:["node/703"],lat:49.5};
    const delta={...candidate,osmId:"node/704",osmIds:["node/704"],address:"100 Test Road Delta"};
    runSql(`INSERT INTO directory_candidates VALUES ('node/703','${JSON.stringify(far)}','live','${candidate.checkedAt}','${expires}'),('node/704','${JSON.stringify(delta)}','live','${candidate.checkedAt}','${expires}')`);
    check(record,"out-of-area coordinates rejected",(await api(base,"admin",{action:"addOsmPlace",osmId:"node/703"})).status===400);
    check(record,"out-of-area address rejected even within bounding box",(await api(base,"admin",{action:"addOsmPlace",osmId:"node/704"})).status===400);
    check(record,"tenant cannot merge another Markaz place",(await api(base,"admin",{action:"mergePlaces",sourceId:"place-other",targetId:"place-2",expectedSourceUpdatedAt:"2026-09-30T00:00:00.000Z",reason:"Wrong group place"})).status===404);
    const custom=await api(base,"admin",{action:"createItem",kind:"place",title:"Task 17 Centre",data:{type:"centre",address:"17 Synthetic Avenue",notes:"Community hall"}});
    check(record,"custom centre saved with user provenance",custom.status===200&&Boolean(custom.data.id),"policy-pass",{status:custom.status,data:custom.data});
    const duplicate=await api(base,"admin",{action:"createItem",kind:"place",title:"Task 17 Centre",data:{type:"centre",address:"17 Synthetic Avenue"}});
    check(record,"physical duplicate needs review",duplicate.status===409&&duplicate.data.duplicates.some(row=>row.id===custom.data.id));
    const duplicateSaved=await api(base,"admin",{action:"createItem",kind:"place",title:"Task 17 Centre",allowPotentialDuplicate:true,data:{type:"centre",address:"17 Synthetic Avenue"}});
    check(record,"reviewed separate custom place allowed",duplicateSaved.status===200);
    const separate=(await api(base,"admin")).data.objects.find(row=>row.id===duplicateSaved.data.id);
    check(record,"unlinked place may be archived with reason",(await api(base,"admin",{action:"archivePlace",sourceId:separate.id,expectedSourceUpdatedAt:separate.updatedAt,reason:"Separate venue no longer needed"})).status===200);
    check(record,"archived place remains readable but cannot be edited",(await api(base,"admin")).data.objects.find(row=>row.id===separate.id)?.status==="archived"&&(await versionedEdit(base,"admin",{action:"updateItem",id:separate.id,title:"Wrong",data:{type:"masjid"}})).status===409);
    const active=(await api(base,"admin")).data.objects.find(row=>row.id===custom.data.id);
    const corrected=await versionedEdit(base,"admin",{action:"updateItem",id:active.id,title:"Task 17 Markaz",data:{type:"markaz",address:"17 Synthetic Avenue",notes:"Corrected",hostPermission:"unknown"}});
    check(record,"custom venue type and details can be corrected",corrected.status===200,"policy-pass",{status:corrected.status,data:corrected.data});
    const linked=(await api(base,"admin")).data.objects.find(row=>row.id==="place-1");
    check(record,"linked place cannot be archived",(await api(base,"admin",{action:"archivePlace",sourceId:linked.id,expectedSourceUpdatedAt:linked.updatedAt,reason:"Archive linked venue"})).status===409);
    const target=(await api(base,"admin")).data.objects.find(row=>row.id==="place-2");
    const merged=await api(base,"admin",{action:"mergePlaces",sourceId:linked.id,targetId:target.id,expectedSourceUpdatedAt:linked.updatedAt,expectedTargetUpdatedAt:target.updatedAt,reason:"Duplicate synthetic venue"});
    check(record,"reviewed place merge succeeds",merged.status===200,{status:merged.status,data:merged.data});
    const after=(await api(base,"admin")).data;
    check(record,"merge retains stays, handovers and profile preferences",after.objects.find(row=>row.id==="place-1")?.status==="archived"&&after.objects.find(row=>row.id==="stay-1")?.data.placeId==="place-2"&&after.objects.find(row=>row.id==="masjid-note-weekend")?.parentId==="place-2"&&after.me.localMasjidId==="place-2");
    check(record,"merge keeps destination host permission",after.objects.find(row=>row.id==="place-2")?.data.hostPermission==="confirmed");
  });
}
async function everydayReview() {
  await session("Task 18 everyday messaging and scoped work",async(base,record)=>{
    const member=await api(base,"member"),admin=await api(base,"admin");
    check(record,"member view has no private balance or incident records",member.status===200&&admin.data.objects.some(row=>row.kind==="money")&&!member.data.objects.some(row=>row.kind==="money"||row.kind==="incident"),"policy-pass",{privateKinds:member.data.objects.filter(row=>row.kind==="money"||row.kind==="incident").map(row=>row.kind)});
    const requestId="ca0291d7-2071-4b39-91c5-7ed35fd4a12d";
    const body={action:"createItem",kind:"message",parentId:"jamaat-weekend",title:"Message",requestId,data:{text:"Task 18 synthetic conversation message"}};
    const first=await api(base,"member",body);
    check(record,"member saves a conversation message",first.status===200&&Boolean(first.data.id));
    const retry=await api(base,"member",body);
    check(record,"message retry returns existing row",retry.status===200&&retry.data.existing===true&&retry.data.id===first.data.id);
    check(record,"same request ID cannot change message text",(await api(base,"member",{...body,data:{text:"Altered"}})).status===409);
    const messages=(await api(base,"member")).data.objects.filter(row=>row.kind==="message"&&row.id===first.data.id);
    check(record,"retry did not add a second message",messages.length===1&&messages[0].data.text===body.data.text);
    check(record,"nonmember cannot enter conversation",(await api(base,"outsider",{...body,requestId:"6869107e-b1ab-4f14-9d72-b738b9a81f3a"})).status===403);
    const raceBody={...body,requestId:"b79d39e0-9bed-48b0-9f11-71f7b9fae209"};
    const pair=await Promise.all([api(base,"member",raceBody),api(base,"member",raceBody)]);
    check(record,"concurrent duplicate submission creates one message",pair.every(result=>result.status===200)&&pair[0].data.id===pair[1].data.id&&(await api(base,"member")).data.objects.filter(row=>row.id===pair[0].data.id).length===1);
    for(const persona of ["pending","ameer","planner","collaborator","team-ameer","duty-member"]){
      const response=await api(base,persona);
      check(record,`${persona} gets an authorized everyday view`,response.status===200&&response.data.setup==="ready"&&Array.isArray(response.data.objects));
    }
  });
}
async function concurrencyReview() {
  await session("Task 21 generic edit concurrency",async(base,record)=>{
    const first=(await api(base,"admin")).data.objects.find(row=>row.id==="message-weekend");
    check(record,"fixture record has a read version",Boolean(first?.updatedAt));
    const payload={action:"updateItem",id:first.id,expectedUpdatedAt:first.updatedAt};
    check(record,"missing version cannot update",(await api(base,"admin",{action:"updateItem",id:first.id,title:"No version"})).status===409);
    const competing=await Promise.all([
      api(base,"admin",{...payload,title:"First editor"}),
      api(base,"markaz-ameer",{...payload,title:"Second editor"})
    ]);
    check(record,"two authorized editors cannot both overwrite the same version",competing.filter(row=>row.status===200).length===1&&competing.filter(row=>row.status===409).length===1,"policy-pass",{statuses:competing.map(row=>row.status)});
    const saved=(await api(base,"admin")).data.objects.find(row=>row.id===first.id);
    check(record,"winning edit and its new version are visible",["First editor","Second editor"].includes(saved.title)&&saved.updatedAt!==first.updatedAt);
    check(record,"stale retry remains rejected",(await api(base,"admin",{...payload,title:"Silent overwrite"})).status===409);
    const unrelated=(await api(base,"admin")).data.objects.find(row=>row.id==="place-1");
    check(record,"unrelated versioned edit stays usable",(await api(base,"admin",{action:"updateItem",id:unrelated.id,expectedUpdatedAt:unrelated.updatedAt,title:"Independent place edit"})).status===200);
    const final=(await api(base,"admin")).data.objects;
    check(record,"stale write preserved winner and unrelated edit",final.find(row=>row.id===first.id)?.title===saved.title&&final.find(row=>row.id===unrelated.id)?.title==="Independent place edit");
    const me=(await api(base,"admin")).data.me;
    const profileExpected={name:me.name,phone:me.phone,email:me.email,localMasjidId:me.localMasjidId,localMarkazId:me.localMarkazId,nationalMarkazId:me.nationalMarkazId};
    const profile={action:"updateProfile",expectedPerson:profileExpected,...profileExpected};
    check(record,"profile save requires its original snapshot",(await api(base,"admin",{action:"updateProfile",name:"Unversioned profile"})).status===409);
    check(record,"profile first editor saves",(await api(base,"admin",{...profile,name:"Profile first editor"})).status===200);
    check(record,"profile stale editor cannot erase first change",(await api(base,"admin",{...profile,phone:"6045550123"})).status===409&&(await api(base,"admin")).data.me.name==="Profile first editor");
    const target=(await api(base,"admin")).data.people.find(row=>row.id==="p-member");
    const contactExpected={name:target.name,phone:target.phone,email:target.email};
    const correction={action:"updatePersonContact",personId:target.id,expectedPerson:contactExpected,...contactExpected};
    const contactPair=await Promise.all([api(base,"admin",{...correction,name:"Contact first editor"}),api(base,"markaz-ameer",{...correction,name:"Contact second editor"})]);
    check(record,"two contact editors cannot silently overwrite",contactPair.filter(row=>row.status===200).length===1&&contactPair.filter(row=>row.status===409).length===1,"policy-pass",{statuses:contactPair.map(row=>row.status)});
  });
}
async function paginationReview() {
  await session("Task 21 paginated Surrey pilot simulation",async(base,record)=>{
    const totals={admin:{places:6000,messages:1000,privateMeetings:500,notes:500,people:500,memberships:1500},member:{places:6000,messages:1000,privateMeetings:0,notes:0},outsider:{places:6000,messages:0,privateMeetings:0,notes:0}};
    record.pageMeasurements=[];
    for(const [persona,expected] of Object.entries(totals)){
      const ids=new Set(),bulk={places:0,messages:0,privateMeetings:0,notes:0,people:new Set(),memberships:new Set()},pages=[];
      let cursors=null,insertedId=null;
      for(let page=0;page<30;page++){
        const query=cursors?`?${new URLSearchParams(cursors)}`:"";
        const start=performance.now();
        const response=await fetch(`${base}/api/app${query}`,{headers:{"x-audit-persona":persona}});
        const raw=await response.text(),payload=JSON.parse(raw),elapsedMs=Math.round((performance.now()-start)*10)/10;
        check(record,`${persona} page ${page+1} is bounded and authorized`,response.status===200&&payload.objects.length<=500&&payload.memberships.length<=200&&payload.people.length<=720&&payload.objects.every(row=>!ids.has(row.id)),"policy-pass",{status:response.status,objects:payload.objects?.length,memberships:payload.memberships?.length,people:payload.people?.length});
        if(persona==="admin"&&page===0){
          check(record,"first page retains core Today and detail records",["jamaat-weekend","event-ijtema","stay-1"].every(id=>payload.objects.some(row=>row.id===id)));
          check(record,"first page includes linked venue details",payload.relatedPlaces.some(row=>row.id==="place-1"));
        }
        for(const row of payload.objects){ids.add(row.id);if(row.id.startsWith("bulk-place-"))bulk.places++;if(row.id.startsWith("bulk-message-"))bulk.messages++;if(row.id.startsWith("bulk-private-"))bulk.privateMeetings++;if(row.id.startsWith("bulk-note-"))bulk.notes++;}
        for(const row of payload.people){if(row.id.startsWith("p-bulk-"))bulk.people.add(row.id);if(persona!=="admin"&&row.id.startsWith("p-bulk-")&&row.phone!==null)throw new Error(`${persona} received a bulk roster phone`);}
        for(const row of payload.memberships)if(row.id.startsWith("m-bulk-"))bulk.memberships.add(row.id);
        pages.push({number:page+1,objects:payload.objects.length,memberships:payload.memberships.length,people:payload.people.length,bytes:Buffer.byteLength(raw),elapsedMs});
        if(persona==="admin"&&page===0){
          const inserted=await api(base,"admin",{action:"createItem",kind:"event",title:"Task 21 between-page event",startAt:"2026-10-03",endAt:"2026-10-03",data:{type:"Ijtema",details:"Synthetic cursor test"}});
          check(record,"new record can be inserted after first page",inserted.status===200,"policy-pass",{status:inserted.status});
          insertedId=inserted.data.id;
          const refreshed=await api(base,"admin");
          check(record,"fresh first page shows inserted record",refreshed.data.objects.some(row=>row.id===insertedId));
        }
        if(!payload.nextObjectCursor&&!payload.nextMembershipCursor&&!payload.nextPeopleCursor)break;
        cursors={objectCursor:payload.nextObjectCursor||"done",membershipCursor:payload.nextMembershipCursor||"done",peopleCursor:payload.nextPeopleCursor||"done"};
        if(page===29)throw new Error(`${persona} pagination did not terminate`);
      }
      record.pageMeasurements.push({persona,pages,queryPlan:record.pageQueryPlan});
      if(persona==="admin")check(record,"old cursor does not duplicate newer insertion",!ids.has(insertedId));
      check(record,`${persona} pages contain exactly the expected synthetic object kinds`,bulk.places===expected.places&&bulk.messages===expected.messages&&bulk.privateMeetings===expected.privateMeetings&&bulk.notes===expected.notes,"policy-pass",{actual:{places:bulk.places,messages:bulk.messages,privateMeetings:bulk.privateMeetings,notes:bulk.notes},expected});
      if(persona==="admin")check(record,"leader roster pages have no missing bulk people or memberships",bulk.people.size===expected.people&&bulk.memberships.size===expected.memberships,"policy-pass",{people:bulk.people.size,memberships:bulk.memberships.size});
    }
    const localRun=[];
    for(let i=0;i<20;i++){
      const start=performance.now(),response=await fetch(`${base}/api/app`,{headers:{"x-audit-persona":"admin"}}),raw=await response.text();
      if(response.status!==200)throw new Error(`Bounded read ${i+1} returned ${response.status}`);
      localRun.push({elapsedMs:Math.round((performance.now()-start)*10)/10,bytes:Buffer.byteLength(raw)});
    }
    const sorted=localRun.map(row=>row.elapsedMs).sort((a,b)=>a-b);
    record.boundedRun={requests:20,medianMs:sorted[9],p95Ms:sorted[18],maxBytes:Math.max(...localRun.map(row=>row.bytes)),samples:localRun};
    check(record,"20 repeated initial reads stay bounded",localRun.length===20&&record.boundedRun.maxBytes<500000,"policy-pass",record.boundedRun);
    check(record,"query plan uses a Markaz index",record.pageQueryPlan.includes("idx_objects_workspace_page"),"policy-pass",{plan:record.pageQueryPlan.slice(-500)});
  },"audit/fixture-task-21-pagination.sql");
}
async function abuseReview() {
  await session("Task 22 response policy and bounded input",async(base,record)=>{
    const admin=await api(base,"admin"),member=await api(base,"member"),anonymous=await api(base,"anonymous");
    check(record,"sensitive success and denial responses are private no-store",[admin,member,anonymous].every(row=>row.headers["cache-control"]==="private, no-store"));
    const html=await fetch(`${base}/`,{headers:{"x-audit-persona":"admin"}}),csp=html.headers.get("content-security-policy")||"";
    check(record,"authenticated HTML has compatible security policy",html.status===200&&csp.includes("frame-ancestors 'self' https://chatgpt.com")&&csp.includes("script-src 'self' 'unsafe-inline'")&&html.headers.get("x-content-type-options")==="nosniff"&&html.headers.get("referrer-policy")==="no-referrer","policy-pass",{status:html.status,csp});
    check(record,"HTML still renders the app",(await html.text()).includes("My Jamaat"));
    const foreign=await api(base,"admin",{action:"updateProfile"},{headers:{origin:"https://unrelated.example"}});
    check(record,"foreign Origin denied without CORS permission",foreign.status===403&&!foreign.headers["access-control-allow-origin"]);
    const fetchSite=await api(base,"admin",{action:"updateProfile"},{headers:{"sec-fetch-site":"cross-site"}});
    check(record,"cross-site fetch metadata denied without Origin",fetchSite.status===403);
    const preflight=await fetch(`${base}/api/app`,{method:"OPTIONS",headers:{origin:"https://unrelated.example","access-control-request-method":"POST","access-control-request-headers":"content-type"}});
    check(record,"foreign preflight grants no CORS access",!preflight.headers.get("access-control-allow-origin"));
    const spoofed=await fetch(`${base}/api/app`,{headers:{"x-audit-persona":"anonymous","oai-authenticated-user-id":"audit-auth-admin","oai-authenticated-user-email":"admin@example.test"}});
    check(record,"anonymous caller header spoof remains denied",spoofed.status===401);
    const oversized=await fetch(`${base}/api/app`,{method:"POST",headers:{"x-audit-persona":"admin","content-type":"application/json"},body:"x".repeat(1_000_001)});
    check(record,"oversized JSON rejected before parsing",oversized.status===413&&(await oversized.json()).error==="Request is too large.");
    let invalidUtf8Bounded=false;
    try{await readBoundedUtf8(new Request(`${base}/api/app`,{method:"POST",body:new Uint8Array([0xff])}));}
    catch(error){invalidUtf8Bounded=error instanceof RequestBodyError&&error.status===400;}
    check(record,"invalid UTF-8 receives controlled input error",invalidUtf8Bounded);
    const malformed=await fetch(`${base}/api/app`,{method:"POST",headers:{"x-audit-persona":"admin","content-type":"application/json"},body:"{broken"});
    check(record,"malformed JSON receives controlled error",malformed.status===400,"policy-pass",{status:malformed.status,body:(await malformed.text()).slice(0,200)});
    let fileRead=false;
    try{await preflightXlsx({size:2_000_001,arrayBuffer:async()=>{fileRead=true;return new ArrayBuffer(0);}});}catch{}
    check(record,"import rejects compressed-size limit before expansion",!fileRead);
    const archive=new Uint8Array(68),view=new DataView(archive.buffer);
    view.setUint32(0,0x02014b50,true);view.setUint16(10,8,true);view.setUint32(20,10,true);view.setUint32(24,4_000_001,true);
    view.setUint32(46,0x06054b50,true);view.setUint16(56,1,true);view.setUint32(58,46,true);
    let expandedDenied=false;
    try{await preflightXlsx({size:archive.length,arrayBuffer:async()=>archive.buffer});}catch(error){expandedDenied=String(error).includes("expanded workbook");}
    check(record,"import rejects excessive expanded ZIP entry",expandedDenied);
    let rowsDenied=false;
    try{boundSheets([{name:"Synthetic",rows:Array.from({length:1001},()=>["Name"])}]);}catch{rowsDenied=true;}
    check(record,"import row bound still applies",rowsDenied);
    const chunks=[new Uint8Array(600_000),new Uint8Array(600_000)];
    const stream=new ReadableStream({pull(controller){const next=chunks.shift();if(next)controller.enqueue(next);else controller.close();}});
    const chunked=await fetch(`${base}/api/app`,{method:"POST",headers:{"x-audit-persona":"admin","content-type":"application/json"},body:stream,duplex:"half"});
    const chunkedText=await chunked.text();
    check(record,"chunked request without length is bounded",chunked.status===413,"policy-pass",{status:chunked.status,body:chunkedText.slice(0,150)});
  });
  await session("Task 22 user and tenant rate boundaries",async(base,record,{directory,env})=>{
    const wrong={action:"joinMarkaz",code:"INVALID-SYNTHETIC",name:"Synthetic join"};
    const attempts=[];
    for(let i=0;i<6;i++)attempts.push(await api(base,"new",wrong));
    check(record,"join attempts receive 429 at user limit",attempts.slice(0,5).every(row=>row.status===400)&&attempts[5].status===429&&Number(attempts[5].headers["retry-after"])>0,"policy-pass",{statuses:attempts.map(row=>row.status)});
    check(record,"another user remains able to attempt a join",(await api(base,"new-second",wrong)).status===400);
    command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--command","UPDATE abuse_counters SET window_start=0,hits=0 WHERE key LIKE 'join:user:%'"],env);
    check(record,"join limit recovers after window rollover",(await api(base,"new",wrong)).status===400);
    const invalidClaim={action:"claimInvitation",token:"INVALID-SYNTHETIC"};
    const claims=[];
    for(let i=0;i<11;i++)claims.push(await api(base,"new-second",invalidClaim));
    check(record,"claim attempts receive 429 at user limit",claims.slice(0,10).every(row=>row.status===400)&&claims[10].status===429&&Number(claims[10].headers["retry-after"])>0,"policy-pass",{statuses:claims.map(row=>row.status)});
    check(record,"another user remains able to attempt a claim",(await api(base,"new",invalidClaim)).status===400);
    command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--command","UPDATE abuse_counters SET window_start=0,hits=0 WHERE key LIKE 'claim:user:%'"],env);
    check(record,"claim limit recovers after window rollover",(await api(base,"new-second",invalidClaim)).status===400);
    const invite={action:"createInvitation",personId:"p-unlinked",mode:"assisted",identityConfirmed:true};
    const invites=[];
    for(let i=0;i<21;i++)invites.push(await api(base,"admin",invite));
    check(record,"invitation creation has a per-user limit",invites.slice(0,20).every(row=>row.status===200)&&invites[20].status===429&&Number(invites[20].headers["retry-after"])>0,"policy-pass",{statuses:invites.map(row=>row.status)});
    check(record,"other Markaz leader is not blocked by first leader",(await api(base,"markaz-ameer",invite)).status===200);
    command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--command","UPDATE abuse_counters SET window_start=0,hits=0 WHERE key LIKE 'invite:user:%'"],env);
    check(record,"invitation limit recovers after window rollover",(await api(base,"admin",invite)).status===200);
    const directoryResponses=[];
    for(let i=0;i<7;i++)directoryResponses.push(await api(base,"admin",undefined,{path:"/api/places"}));
    check(record,"directory has a per-user limit",directoryResponses.slice(0,6).every(row=>row.status===200)&&directoryResponses[6].status===429&&directoryResponses[6].headers["cache-control"]==="private, no-store","policy-pass",{statuses:directoryResponses.map(row=>row.status)});
    check(record,"other leader retains directory access",(await api(base,"markaz-ameer",undefined,{path:"/api/places"})).status===200);
    const tenantDigest=createHash("sha256").update("tenant:markaz-surrey").digest("hex");
    const seedTenant=(group,limit,windowMs)=>command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--command",`INSERT INTO abuse_counters (key,window_start,hits) VALUES ('${group}:tenant:${tenantDigest}',${Math.floor(Date.now()/windowMs)*windowMs},${limit}) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,hits=excluded.hits`],env);
    seedTenant("join",60,15*60_000);
    const validJoin={action:"joinMarkaz",code:"AUDIT-SURREY-2026",name:"Synthetic tenant join"};
    check(record,"Surrey tenant join ceiling denies another user",(await api(base,"new-contactless",validJoin)).status===429);
    check(record,"other Markaz join remains available",(await api(base,"new-second",{...validJoin,code:"AUDIT-OTHER-2026"})).status===200);
    seedTenant("directory",60,15*60_000);
    check(record,"Surrey tenant directory ceiling denies another leader",(await api(base,"markaz-ameer",undefined,{path:"/api/places"})).status===429);
    check(record,"other Markaz directory remains available",(await api(base,"other-admin",undefined,{path:"/api/places"})).status===200);
    seedTenant("write",600,60_000);
    check(record,"Surrey tenant write ceiling denies a write",(await api(base,"markaz-ameer",{action:"updateProfile",name:"Synthetic"})).status===429);
    check(record,"other Markaz write remains available",(await api(base,"other-admin",{action:"updateProfile",name:"Synthetic"})).status!==429);
  });
}
async function historyReview(){
  await session("Task 23 audit, export and lifecycle",async(base,record,{directory,env})=>{
    const path="/api/history?view=audit";
    check(record,"ordinary member cannot read Markaz audit",(await api(base,"member",undefined,{path})).status===403);
    check(record,"anonymous caller cannot read history",(await api(base,"anonymous",undefined,{path})).status===401);
    const spoof=await fetch(`${base}${path}`,{headers:{"x-audit-persona":"anonymous","oai-authenticated-user-id":"audit-auth-admin","oai-authenticated-user-email":"admin@example.test"}});
    check(record,"local gateway strips forged history identity headers",spoof.status===401);
    const foreign=await api(base,"other-admin",undefined,{path});
    check(record,"other Markaz starts with separate history",foreign.status===200&&!JSON.stringify(foreign.data).includes("markaz-surrey"));
    const added=await api(base,"admin",{action:"addMember",jamaatId:"jamaat-weekend",personId:"p-outsider"});
    check(record,"leader adds synthetic membership",added.status===200);
    const granted=await api(base,"admin",{action:"setMemberPermission",jamaatId:"jamaat-weekend",personId:"p-outsider",scopes:["notes"]});
    check(record,"leader grants scoped permission",granted.status===200);
    check(record,"leader revokes scoped permission",(await api(base,"admin",{action:"revokeMemberPermissions",jamaatId:"jamaat-weekend",personId:"p-outsider"})).status===200);
    const role=await api(base,"admin",{action:"setMarkazRole",personId:"p-outsider",role:"markaz_ameer"});
    check(record,"leader records role appointment",role.status===200);
    const incident=await api(base,"admin",{action:"createItem",kind:"incident",parentId:"jamaat-weekend",title:"Task 23 synthetic incident",data:{severity:"low",description:"Synthetic incident detail",followUp:"Synthetic follow-up"}});
    check(record,"synthetic incident created",incident.status===200);
    const current=()=>api(base,"admin");
    const incidentRow=(await current()).data.objects.find(row=>row.id===incident.data.id);
    const corrected=await api(base,"admin",{action:"reviseRecordedInfo",id:incidentRow.id,expectedUpdatedAt:incidentRow.updatedAt,title:incidentRow.title,reason:"Correct synthetic detail",status:"resolved",data:{severity:"low",description:"Corrected synthetic incident",followUp:"Review complete"}});
    check(record,"incident correction creates revision",corrected.status===200);
    const money=(await current()).data.objects.find(row=>row.id==="money-collection");
    const baraka=await api(base,"admin",{action:"correctBaraka",originalId:money.id,expectedUpdatedAt:money.updatedAt,idempotencyKey:"task23-ledger-correction",mode:"reverse",reason:"Synthetic receipt correction",date:"2026-10-02"});
    check(record,"ledger correction creates reversal",baraka.status===200);
    const invite=await api(base,"admin",{action:"createInvitation",personId:"p-unlinked",mode:"assisted",identityConfirmed:true});
    check(record,"leader issues local synthetic invitation",invite.status===200);
    check(record,"synthetic identity link succeeds",(await api(base,"new-contactless",{action:"claimInvitation",token:invite.data.token})).status===200);
    const history=await api(base,"admin",undefined,{path});
    const events=history.data.events||[];
    check(record,"leader sees attributed access and correction events",history.status===200&&events.some(row=>row.action==="member.add"&&row.subjectId==="p-outsider"&&row.actorId==="p-admin")&&events.some(row=>row.action==="member.permission"&&row.summary.nextScopes.includes("notes"))&&events.some(row=>row.action==="member.permission.revoke"&&row.subjectId==="p-outsider")&&events.some(row=>row.action==="markaz.role"&&row.summary.nextRole==="markaz_ameer")&&events.some(row=>row.action==="incident.revise"&&row.summary.nextStatus==="resolved")&&events.some(row=>row.action==="money.correction")&&events.some(row=>row.action==="person.claim.link"),"policy-pass",{actions:events.map(row=>row.action)});
    check(record,"audit view omits sensitive incident and ledger content",!JSON.stringify(history.data).includes("INCIDENT_CANARY_PRIVATE")&&!JSON.stringify(history.data).includes("PRIVATE_BARAKA_CANARY")&&!JSON.stringify(history.data).includes("Corrected synthetic incident"));
    const otherAfter=await api(base,"other-admin",undefined,{path});
    check(record,"other Markaz cannot read Surrey actions",!JSON.stringify(otherAfter.data).includes("p-outsider")&&!JSON.stringify(otherAfter.data).includes(incident.data.id));
    const beforeArchive=(await current()).data.objects.find(row=>row.id===incident.data.id);
    const arch={action:"archiveRecord",id:incident.data.id,expectedUpdatedAt:beforeArchive.updatedAt,reason:"Synthetic report duplicate"};
    check(record,"ordinary member cannot archive incident",(await api(base,"member",arch,{path:"/api/history"})).status===403);
    check(record,"foreign Markaz cannot archive incident",(await api(base,"other-admin",arch,{path:"/api/history"})).status===404);
    check(record,"archive requires a reason",(await api(base,"admin",{...arch,reason:"short"},{path:"/api/history"})).status===400);
    const archived=await api(base,"admin",arch,{path:"/api/history"});
    check(record,"archive preserves record and revision",archived.status===200&&archived.data.status==="archived"&&(await current()).data.objects.some(row=>row.id===incident.data.id&&row.status==="archived"));
    check(record,"stale archive cannot replay",(await api(base,"admin",arch,{path:"/api/history"})).status===409);
    const restore=await api(base,"admin",{action:"restoreRecord",id:incident.data.id,expectedUpdatedAt:archived.data.updatedAt},{path:"/api/history"});
    const restored=(await current()).data.objects.find(row=>row.id===incident.data.id);
    check(record,"restore reconciles status and retains content",restore.status===200&&restored.status==="resolved"&&restored.data.description==="Corrected synthetic incident");
    const revisions=(await current()).data.recordedRevisions.filter(row=>row.objectId===incident.data.id);
    check(record,"archive and restore both leave revisions",revisions.some(row=>row.after.status==="archived")&&revisions.some(row=>row.after.status==="resolved"));
    command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--command",`INSERT INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at) VALUES ('task23-linked-child','markaz-surrey','note','${incident.data.id}','Synthetic linked child','planned','{}','p-admin','2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z')`],env);
    check(record,"linked child prevents archive without changing the parent",(await api(base,"admin",{action:"archiveRecord",id:incident.data.id,expectedUpdatedAt:restored.updatedAt,reason:"Review linked synthetic child"},{path:"/api/history"})).status===409&&(await current()).data.objects.find(row=>row.id===incident.data.id)?.status==="resolved");
    const member=(await api(base,"member")).data.me;
    const expectedPerson={name:member.name,phone:member.phone,email:member.email,localMasjidId:member.localMasjidId,localMarkazId:member.localMarkazId,nationalMarkazId:member.nationalMarkazId};
    check(record,"synthetic formula-like Unicode name saves for export probe",(await api(base,"member",{action:"updateProfile",expectedPerson,name:"=SUM(1,1) محمد",phone:member.phone,email:member.email,localMasjidId:member.localMasjidId,localMarkazId:member.localMarkazId,nationalMarkazId:member.nationalMarkazId})).status===200);
    const exported=await fetch(`${base}/api/history?view=mine`,{headers:{"x-audit-persona":"member"}}),exportBytes=Buffer.from(await exported.arrayBuffer()),csv=exportBytes.toString("utf8");
    const exportChecks={private:exported.headers.get("cache-control")==="private, no-store",formula:csv.includes("'=SUM(1,1) محمد"),bom:exportBytes.subarray(0,3).toString("hex")==="efbbbf",membership:csv.includes("membership-jamaat-weekend-p-member"),noAdmin:!csv.includes("admin@example.test"),noIncident:!csv.includes("INCIDENT_CANARY_PRIVATE")};
    check(record,"personal export is private and spreadsheet-safe",exported.status===200&&Object.values(exportChecks).every(Boolean),"policy-pass",{status:exported.status,bytes:Buffer.byteLength(csv),exportChecks});
    const repeatExports=[];
    for(let i=0;i<5;i++)repeatExports.push(await fetch(`${base}/api/history?view=mine`,{headers:{"x-audit-persona":"member"}}));
    check(record,"repeated personal exports receive a recoverable limit",repeatExports.slice(0,4).every(response=>response.status===200)&&repeatExports[4].status===429&&Number(repeatExports[4].headers.get("retry-after"))>0);
    check(record,"another person's export remains available",(await fetch(`${base}/api/history?view=mine`,{headers:{"x-audit-persona":"admin"}})).status===200);
    const dry=await api(base,"admin",undefined,{path:"/api/history?view=retention"});
    check(record,"retention dry run has no active policy or deletion",dry.status===200&&dry.data.dryRun===true&&dry.data.deletionEnabled===false&&dry.data.policyDecisionRequired===true&&dry.data.report.every(row=>row.configuredDays===null&&row.proposedCount===null));
    check(record,"ordinary member cannot read Markaz retention report",(await api(base,"member",undefined,{path:"/api/history?view=retention"})).status===403);
    check(record,"policy needs a separate owner reference",(await api(base,"admin",{action:"setRetentionPolicy",category:"audit",days:1},{path:"/api/history"})).status===400);
    check(record,"Markaz Ameer cannot record owner policy",(await api(base,"markaz-ameer",{action:"setRetentionPolicy",category:"audit",days:1,policyReference:"Synthetic owner review"},{path:"/api/history"})).status===403);
    const policy=await api(base,"admin",{action:"setRetentionPolicy",category:"audit",days:1,policyReference:"Synthetic owner review only"},{path:"/api/history"});
    const reviewed=await api(base,"admin",undefined,{path:"/api/history?view=retention"});
    const auditRetention=reviewed.data.report.find(row=>row.category==="audit");
    check(record,"configured policy still only proposes a dry run",policy.status===200&&reviewed.data.deletionEnabled===false&&auditRetention?.policyReference==="Synthetic owner review only"&&typeof auditRetention?.proposedCount==="number","policy-pass",{policyStatus:policy.status,auditRetention});
    command(["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",directory,"--command","WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<110) INSERT INTO audit (id,markaz_id,actor_id,action,object_id,created_at) SELECT printf('task23-page-%03d',x),'markaz-surrey','p-admin','test.bounded-page',NULL,'2020-01-01T00:00:00.000Z' FROM seq"],env);
    const firstPage=await api(base,"admin",undefined,{path});
    const secondPage=await api(base,"admin",undefined,{path:`${path}&cursor=${encodeURIComponent(firstPage.data.nextCursor)}`});
    const firstIds=new Set(firstPage.data.events.map(row=>row.id));
    check(record,"audit history pages at 100 without duplicates",firstPage.status===200&&firstPage.data.events.length===100&&firstPage.data.nextCursor&&secondPage.status===200&&secondPage.data.events.length>0&&secondPage.data.events.every(row=>!firstIds.has(row.id)));
    check(record,"other Markaz cannot see synthetic audit pages",!(await api(base,"other-admin",undefined,{path})).data.events.some(row=>String(row.id).startsWith("task23-page-")));
  });
}
// Only reads the disposable local database. Never opens a remote database or
// ordinary preview persistence. Canonical hashes keep private fixture values
// out of the recovery report while checking every user-table row.
function localDatabase(directory) {
  if(!path.basename(directory).startsWith("my-jamaat-repair-"))throw new Error("Recovery requires a disposable audit directory");
  for(const name of readdirSync(directory,{recursive:true})) {
    if(!String(name).endsWith(".sqlite"))continue;
    const db=new DatabaseSync(path.join(directory,name),{readOnly:true});
    if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='objects'").get())return db;
    db.close();
  }
  throw new Error("Disposable D1 database not found");
}
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function recoverySnapshot(directory) {
  const db=localDatabase(directory),snapshot={};
  try {
    for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      const rows=db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(canonical(row))).sort();
      snapshot[name]={rows:rows.length,sha256:createHash("sha256").update(rows.join("\n")).digest("hex")};
    }
    return snapshot;
  } finally {db.close();}
}
function exportRecovery(directory,env,file) {
  // This installed Wrangler's local export has no --persist-to argument.
  // Read a consistent SQLite transaction from the exact synthetic namespace
  // instead of accidentally exporting the ordinary preview database.
  const db=localDatabase(directory),statements=[];
  const identifier=value=>`"${value.replaceAll('"','""')}"`;
  const literal=value=>{
    if(value===null)return "NULL";
    if(typeof value==="string")return `'${value.replaceAll("'","''")}'`;
    if(typeof value==="bigint"||typeof value==="number"&&Number.isFinite(value))return String(value);
    if(value instanceof Uint8Array)return `X'${Buffer.from(value).toString("hex")}'`;
    throw new Error("Unsupported local backup value");
  };
  try {
    db.exec("BEGIN");
    const schema=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*' ORDER BY name").all();
    for(const row of schema.filter(row=>row.type==="table")) {
      statements.push(row.sql+";");
      for(const value of db.prepare(`SELECT * FROM ${identifier(row.name)}`).all())statements.push(`INSERT INTO ${identifier(row.name)} (${Object.keys(value).map(identifier).join(",")}) VALUES (${Object.values(value).map(literal).join(",")});`);
    }
    for(const row of schema.filter(row=>row.type!=="table"))statements.push(row.sql+";");
    db.exec("COMMIT");
  }finally{db.close();}
  writeFileSync(file,statements.join("\n")+"\n",{mode:0o600});
  return {method:"consistent read-only SQLite transaction from disposable D1; SQL imported using Wrangler --local --persist-to",sha256:createHash("sha256").update(readFileSync(file)).digest("hex"),bytes:readFileSync(file).length};
}
async function recoveryReview() {
  const backups=mkdtempSync(path.join(os.tmpdir(),"my-jamaat-recovery-"));
  const legacyFile=path.join(backups,"legacy.sql"),currentFile=path.join(backups,"current.sql");
  let legacyPeople,legacyObjects,legacyMembershipIds,currentSnapshot,correctionId,postBackupId;
  try {
    await session("Task 24 synthetic backup source",async(base,record,{directory,env})=>{
      const grant=await api(base,"admin",{action:"setMemberPermission",jamaatId:"jamaat-weekend",personId:"p-contacts",scopes:["contacts"]});
      check(record,"backup contains an explicitly authorized contact grant",grant.status===200);
      check(record,"backup contains a revoked planner grant",(await api(base,"admin",{action:"setMemberPermission",jamaatId:"jamaat-weekend",personId:"p-planner",scopes:["route","notes"]})).status===200&&(await api(base,"admin",{action:"revokeMemberPermissions",jamaatId:"jamaat-weekend",personId:"p-planner"})).status===200);
      const before=(await api(base,"admin")).data.objects.find(row=>row.id==="money-collection");
      const correction=await api(base,"admin",{action:"correctBaraka",originalId:before.id,expectedUpdatedAt:before.updatedAt,idempotencyKey:"task24-recovery-correction",mode:"replace",reason:"Synthetic receipt reconciliation",date:"2026-10-02",replacement:{title:"Recovery receipt",type:"collection",amountCents:1234,note:"Synthetic recovery test",reference:"R-recovery"}});
      correctionId=correction.data.id;
      check(record,"backup contains original reversal replacement and audit",correction.status===200&&!!correction.data.replacementId);
      const incident=(await api(base,"admin")).data.objects.find(row=>row.id==="incident-weekend");
      check(record,"backup contains archived incident and revision",(await api(base,"admin",{action:"archiveRecord",id:incident.id,expectedUpdatedAt:incident.updatedAt,reason:"Synthetic recovery archive"},{path:"/api/history"})).status===200);
      const invitation=await api(base,"admin",{action:"createInvitation",personId:"p-unlinked",mode:"assisted",identityConfirmed:true});
      check(record,"backup contains claimed identity and retained work",invitation.status===200&&(await api(base,"new-contactless",{action:"claimInvitation",token:invitation.data.token})).status===200);
      currentSnapshot=recoverySnapshot(directory);
      record.snapshot=currentSnapshot;
      record.export=exportRecovery(directory,env,currentFile);
      check(record,"export leaves every user-table row unchanged",JSON.stringify(recoverySnapshot(directory))===JSON.stringify(currentSnapshot));
      const later=await api(base,"admin",{action:"createItem",kind:"money",parentId:"jamaat-weekend",idempotencyKey:"task24-post-backup",title:"After backup only",data:{type:"collection",amountCents:1,currency:"CAD",date:"2026-10-02",note:"Synthetic later write"}});
      postBackupId=later.data.id;
      check(record,"source can advance independently after snapshot",later.status===200);
    },"audit/repair-task-03-legacy-fixture.sql",false,{beforeMigrations:async(record,{directory,env})=>{
      const db=localDatabase(directory);
      try {
        legacyPeople=db.prepare("SELECT id,auth_id,name,email,phone,role FROM people ORDER BY id").all();
        legacyObjects=db.prepare("SELECT id,markaz_id,kind,parent_id,title FROM objects ORDER BY id").all();
        legacyMembershipIds=db.prepare("SELECT id FROM memberships ORDER BY id").all().map(row=>row.id);
      }finally{db.close();}
      record.legacyExport=exportRecovery(directory,env,legacyFile);
    }});
    await session("Task 24 current snapshot restored to new D1",async(base,record,{directory})=>{
      const restored=recoverySnapshot(directory);
      record.snapshot=restored;
      check(record,"all user tables and complete rows match the backup",JSON.stringify(restored)===JSON.stringify(currentSnapshot),"policy-pass",{tables:Object.keys(restored),totalRows:Object.values(restored).reduce((n,t)=>n+t.rows,0)});
      const admin=await api(base,"admin"),member=await api(base,"member"),planner=await api(base,"planner"),contacts=await api(base,"contacts"),other=await api(base,"other-admin"),linked=await api(base,"new-contactless");
      check(record,"restored routes retain all three venue references",[1,2,3].every(n=>admin.data.objects.some(row=>row.id===`stay-${n}`&&row.data.placeId===`place-${n}`)));
      check(record,"restored ledger preserves correction and excludes later write",admin.data.objects.some(row=>row.id===correctionId&&row.data.reversalOf==="money-collection")&&!admin.data.objects.some(row=>row.id===postBackupId)&&admin.data.objects.some(row=>row.id==="money-collection"));
      check(record,"restored archive and revision preserve history",admin.data.objects.some(row=>row.id==="incident-weekend"&&row.status==="archived")&&admin.data.recordedRevisions.some(row=>row.objectId==="incident-weekend"));
      check(record,"restored identity retains exact imported person",linked.data.me.id==="p-unlinked"&&linked.data.memberships.some(row=>row.personId==="p-unlinked"));
      check(record,"restored ordinary member sees no sensitive records or contacts",!member.data.objects.some(row=>["money","incident","note","masjid_note","tashkil"].includes(row.kind))&&member.data.people.find(row=>row.id==="p-ameer")?.phone===null);
      check(record,"restored revoked planner cannot recover authority",!planner.data.objects.some(row=>["money","incident","note"].includes(row.kind))&&(await versionedEdit(base,"planner",{action:"updateItem",id:"jamaat-weekend",data:{route:"FORBIDDEN"}})).status===403);
      check(record,"restored contact grant remains narrow",contacts.data.people.find(row=>row.id==="p-member")?.phone!==null&&!contacts.data.objects.some(row=>row.kind==="incident"||row.kind==="money"));
      check(record,"restored tenant boundary excludes Surrey",!JSON.stringify(other.data).includes("incident-weekend")&&!other.data.objects.some(row=>row.id==="jamaat-weekend"));
      check(record,"restored audit attribution remains visible only to leaders",(await api(base,"admin",undefined,{path:"/api/history?view=audit"})).data.events.some(row=>row.action==="money.correction"&&row.actorId==="p-admin")&&(await api(base,"member",undefined,{path:"/api/history?view=audit"})).status===403);
      const money=admin.data.objects.find(row=>row.id==="money-collection");
      const retry=await api(base,"admin",{action:"correctBaraka",originalId:money.id,expectedUpdatedAt:money.updatedAt,idempotencyKey:"task24-recovery-correction",mode:"replace",reason:"Synthetic receipt reconciliation",date:"2026-10-02",replacement:{title:"Recovery receipt",type:"collection",amountCents:1234,note:"Synthetic recovery test",reference:"R-recovery"}});
      check(record,"restored idempotency key prevents duplicate correction",retry.status===200&&retry.data.id===correctionId);
      const currentIncident=(await api(base,"admin")).data.objects.find(row=>row.id==="incident-weekend");
      check(record,"restored archive can be restored through current API",(await api(base,"admin",{action:"restoreRecord",id:currentIncident.id,expectedUpdatedAt:currentIncident.updatedAt,reason:"Synthetic restored database review"},{path:"/api/history"})).status===200);
      for(const url of ["/__test/persona","/audit/personas.json","/audit/fixture.sql"]){const response=await fetch(`http://127.0.0.1:${record.workerPort}${url}`,{headers:{"oai-authenticated-user-id":"audit-auth-admin","oai-authenticated-user-email":"admin@example.test"}});check(record,`production app does not serve ${url}`,response.status===404);await response.body?.cancel();}
      check(record,"restored API retains private no-store policy",admin.headers["cache-control"]==="private, no-store");
    },undefined,false,{restoreSql:currentFile});
    await session("Task 24 legacy snapshot restored and forward migrated",async(base,record,{directory})=>{
      const db=localDatabase(directory);
      try {
        check(record,"forward migrations preserve existing person values",JSON.stringify(db.prepare("SELECT id,auth_id,name,email,phone,role FROM people ORDER BY id").all())===JSON.stringify(legacyPeople));
        const migratedObjects=db.prepare("SELECT id,markaz_id,kind,parent_id,title FROM objects ORDER BY id").all();
        const changed=legacyObjects.filter(old=>JSON.stringify(migratedObjects.find(row=>row.id===old.id))!==JSON.stringify(old));
        check(record,"forward migrations retain every object identity and parent",changed.length===0,"policy-pass",{changedIds:changed.map(row=>row.id),newIds:migratedObjects.filter(row=>!legacyObjects.some(old=>old.id===row.id)).map(row=>row.id)});
        const memberIds=new Set(db.prepare("SELECT id FROM memberships").all().map(row=>row.id));
        check(record,"forward migrations retain attributed memberships",legacyMembershipIds.every(id=>memberIds.has(id)));
      }finally{db.close();}
      const admin=await api(base,"admin"),planner=await api(base,"planner");
      check(record,"forward migrations queue historical issues without discarding rows",admin.data.repairReviews.length>0&&admin.data.objects.some(row=>row.id==="legacy-invalid-money"));
      check(record,"migrated old grants do not reveal incidents or ledger",!planner.data.objects.some(row=>row.kind==="incident"||row.kind==="money"));
      check(record,"migrated history endpoint works",(await api(base,"admin",undefined,{path:"/api/history?view=retention"})).data.deletionEnabled===false);
      record.snapshot=recoverySnapshot(directory);
    },undefined,false,{restoreSql:legacyFile,applyMigrations:true});
    const files=readdirSync(path.join(root,"dist/server"),{recursive:true}).filter(name=>/\.(js|mjs)$/.test(name)).map(name=>readFileSync(path.join(root,"dist/server",name),"utf8"));
    const clientFiles=readdirSync(path.join(root,"dist/client"),{recursive:true}).filter(name=>/\.(js|mjs)$/.test(name)).map(name=>readFileSync(path.join(root,"dist/client",name),"utf8"));
    check(result.sessions.at(-1),"production bundles exclude persona selectors and local auth",!["audit_persona","x-audit-persona","/__test/persona","__sites_local_auth","audit-auth-admin","local_seedy","seedy@sites.test"].some(marker=>[...files,...clientFiles].some(source=>source.includes(marker))));
  }finally{rmSync(backups,{recursive:true,force:true});}
}
try {
  if(suite==="all"||suite==="dependency-smoke") await dependencySmoke();
  if(suite==="all"||suite==="daily") await daily();
  if(suite==="all"||suite==="authorization-baseline") await authorizationBaseline();
  if(suite==="all"||suite==="isolation") await isolation();
  if(suite==="all"||suite==="validation") await validation();
  if(suite==="all"||suite==="ameer") await ameer();
  if(suite==="all"||suite==="permissions") await permissions();
  if(suite==="all"||suite==="revocation") await revocation();
  if(suite==="all"||suite==="resolution") await resolution();
  if(suite==="all"||suite==="onboarding") await onboarding();
  if(suite==="all"||suite==="import") await importRoster();
  if(suite==="all"||suite==="privacy") await privacyReview();
  if(suite==="all"||suite==="time") await timeReview();
  if(suite==="all"||suite==="route") await routeReview();
  if(suite==="all"||suite==="series") await seriesReview();
  if(suite==="all"||suite==="mashwara") await mashwaraReview();
  if(suite==="all"||suite==="ijtema") await ijtemaReview();
  if(suite==="all"||suite==="baraka") await barakaReview();
  if(suite==="all"||suite==="recorded") await recordedReview();
  if(suite==="all"||suite==="places") await placesReview();
  if(suite==="all"||suite==="everyday") await everydayReview();
  if(suite==="all"||suite==="concurrency") await concurrencyReview();
  if(suite==="all"||suite==="pagination") await paginationReview();
  if(suite==="all"||suite==="abuse") await abuseReview();
  if(suite==="all"||suite==="history") await historyReview();
  if(suite==="recovery") await recoveryReview();
} catch(error) {
  result.errors.push({kind:"harness-or-unexpected-policy-error",message:error.message,stack:error.stack});
  process.exitCode=1;
}
result.finishedAt=new Date().toISOString();
result.status=result.errors.length?"FAIL":"PASS";
writeFileSync(output,JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({status:result.status,suite,sessions:result.sessions.map(s=>({label:s.label,checks:s.checks.length})),classifications:result.classifications,errors:result.errors.map(e=>e.message),output},null,2));

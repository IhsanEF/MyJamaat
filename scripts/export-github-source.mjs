// Prepare a public source snapshot without private deployment evidence or Git history.
import {execFileSync} from "node:child_process";
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root=fileURLToPath(new URL("../",import.meta.url));
const destination=path.resolve(process.argv[2]||path.join(root,".sites-runtime/github-source"));
if(existsSync(destination))throw new Error("Use a new empty destination for the public snapshot.");
const auditTools=new Set(["README.md","repair-test.mjs","render-runtime-test.mjs","render-browser-server.mjs","route-planning-test.mjs","worker.mjs","proxy.mjs","api.mjs","seed.mjs","personas.json","task-25-browser-server.mjs"]);
const candidates=execFileSync("git",["ls-files","-z","--cached","--others","--exclude-standard"],{cwd:root,encoding:"utf8"}).split("\0").filter(Boolean);
const files=[...new Set(candidates)].filter(name=>{
  if(name.startsWith("audit/"))return auditTools.has(name.slice(6))||name.endsWith(".sql")||/^(audit\/organizer-review-|audit\/repair-task-07-).*\.(csv|xlsx)$/.test(name);
  return !name.startsWith(".")||[".gitignore",".npmrc",".node-version",".env.render.example",".openai/hosting.json"].includes(name);
});
mkdirSync(destination,{recursive:true});
for(const name of files){const target=path.join(destination,name);mkdirSync(path.dirname(target),{recursive:true});copyFileSync(path.join(root,name),target);}
const hosting=JSON.parse(readFileSync(path.join(destination,".openai/hosting.json"),"utf8"));
delete hosting.project_id;
writeFileSync(path.join(destination,".openai/hosting.json"),JSON.stringify(hosting,null,2)+"\n");
writeFileSync(path.join(destination,".gitignore"),readFileSync(path.join(destination,".gitignore"),"utf8")+"\n# Keep generated audit evidence private.\n/audit/*.json\n!/audit/personas.json\n/audit/*.jpg\n/audit/*.png\n");
writeFileSync(path.join(destination,"audit/README.md"),`# Synthetic regression tests\n\nAll fixture identities and records are synthetic. These tools use disposable local databases and loopback listeners. Never apply fixture SQL to production. Use the pinned Node 24.19.0 runtime.\n\nAfter installing dependencies with npm run install:ci and building with npm run build:\n\n- node audit/route-planning-test.mjs\n- node audit/repair-test.mjs route --output=/tmp/my-jamaat-route-verification.json\n- node audit/repair-test.mjs all --output=/tmp/my-jamaat-full-verification.json\n\nFor Render, first run npm run build:render, then node audit/render-runtime-test.mjs and node audit/repair-test.mjs all --runtime=node --output=/tmp/my-jamaat-render-verification.json. The runtime checks use synthetic signed Google tokens with the real verifier and disposable SQLite storage; they do not claim a live Google login or Render deployment. Build targets share dist, so stop servers before switching.\n\nThe browser harness prints a disposable proxy port and accepts an optional output manifest path. Use a persona host such as http://markaz-ameer.localhost:PORT/. Stop it with Ctrl+C to delete its temporary database.\n\nPrivate audit reports, screenshots, production readbacks, and the original deployment Git history are excluded from this public source snapshot.\n`);
console.log(JSON.stringify({destination,files:files.length,privateEvidenceExcluded:true,hostingProjectIdRemoved:true}));

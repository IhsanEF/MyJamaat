// Separate local persistence; never deploy or use the ordinary preview database.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const persistTo = process.env.AUDIT_PERSIST_DIR || ".wrangler/audit-state";
const child = spawn(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "dev", "--config", "dist/server/wrangler.json", "--local", "--persist-to", persistTo, "--ip", "127.0.0.1", "--port", process.env.AUDIT_WORKER_PORT || "5180", "--inspector-port", "0"], {cwd:root, stdio:"inherit"});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => process.exit(code || 0));

import { spawnSync } from 'node:child_process';
import { renameSync, writeFileSync, existsSync } from 'node:fs';
process.env.MY_JAMAAT_TARGET = 'render';
const built = spawnSync(process.execPath, ['node_modules/vinext/dist/cli.js', 'build'], { stdio: 'inherit', env: process.env });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);
if (!existsSync('dist/server/index.js')) throw new Error('Node build entry missing');
renameSync('dist/server/index.js', 'dist/server/framework.js');
// Preserve all entry exports used by lazy chunks. The wrapper authenticates every
// framework request and adds the same response policies as the Worker boundary.
writeFileSync('dist/server/index.js', `import handler from './framework.js';
export * from './framework.js';
import { handleRequest } from '../../runtime/render/handler.mjs';
export default async function(request, ctx) {
  return handleRequest(request, (sanitized) => typeof handler === 'function' ? handler(sanitized,ctx) : handler.fetch(sanitized,process.env,ctx));
}
`);

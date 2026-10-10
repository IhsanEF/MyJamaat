import { startProdServer } from 'vinext/server/prod-server';
import { getDatabase } from '../runtime/render/database.mjs';
import { validateConfiguration } from '../runtime/render/sessions.mjs';
validateConfiguration();
await getDatabase().ready;
const port = Number(process.env.PORT ?? 10000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
const { server } = await startProdServer({ port, host: '0.0.0.0' });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close(() => { getDatabase().close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
});

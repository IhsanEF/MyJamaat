import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
if (process.env.TURSO_DATABASE_URL) throw new Error('Use the Turso dashboard export/restore workflow for remote storage.');
const destination = process.argv[2] && resolve(process.argv[2]);
if (!process.env.SQLITE_PATH || !destination || existsSync(destination)) throw new Error('Set SQLITE_PATH and pass a new private backup filename.');
mkdirSync(dirname(destination),{recursive:true,mode:0o700});
const sqlite = new DatabaseSync(process.env.SQLITE_PATH,{readOnly:true});
try { await backup(sqlite,destination);chmodSync(destination,0o600);console.log('Consistent SQLite backup created. Store it privately outside Render.'); }
finally {sqlite.close();}

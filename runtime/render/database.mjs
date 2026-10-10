import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createClient } from '@libsql/client';

// Implements the prepared statements and atomic batches used by the app's D1 SQL.
// All statements in a batch execute synchronously on one connection and transaction.
export class SqliteDatabase {
  constructor(filename) {
    if (!filename || filename === ':memory:') throw new Error('A durable SQLITE_PATH is required.');
    mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
    this.sqlite = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  }
  prepare(sql) { return new SqliteStatement(this, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => {
        if (!(statement instanceof SqliteStatement) || statement.database !== this) throw new Error('Invalid batch statement');
        return statement.execute();
      });
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  close() { this.sqlite.close(); }
}
class SqliteStatement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new SqliteStatement(this.database, this.sql, values); }
  statement() { return this.database.sqlite.prepare(this.sql); }
  async first(column) {
    const row = this.statement().get(...this.values) ?? null;
    if (column && row && !(column in row)) throw new Error('Unknown result column');
    return column ? row?.[column] ?? null : row;
  }
  execute() {
    const started = performance.now();
    const statement = this.statement();
    const before = this.database.sqlite.prepare('SELECT total_changes() AS n').get().n;
    const results = statement.all(...this.values);
    const changes = this.database.sqlite.prepare('SELECT total_changes() AS n').get().n - before;
    const lastRowId = this.database.sqlite.prepare('SELECT last_insert_rowid() AS n').get().n;
    return { success: true, results, meta: { changes, last_row_id: lastRowId, duration: performance.now() - started } };
  }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
  async raw(options = {}) {
    const statement = this.statement();
    const names = statement.columns().map(column => column.name);
    const rows = statement.all(...this.values).map(row => names.map(name => row[name]));
    return options.columnNames ? [names, ...rows] : rows;
  }
}

export function migrate(database, directory = resolve('drizzle')) {
  const sqlite = database.sqlite;
  sqlite.exec('CREATE TABLE IF NOT EXISTS render_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const migrations = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    for (const name of migrations) {
      const sql = readFileSync(resolve(directory, name), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const existing = sqlite.prepare('SELECT sha256 FROM render_migrations WHERE name=?').get(name);
      if (existing) { if (existing.sha256 !== hash) throw new Error(`Migration changed: ${name}`); continue; }
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO render_migrations VALUES (?,?,?)').run(name, hash, new Date().toISOString());
    }
    sqlite.exec(`CREATE TABLE IF NOT EXISTS render_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL,
      full_name TEXT, expires_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS render_sessions_expiry ON render_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS render_login_attempts (
      state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL,
      return_to TEXT NOT NULL, expires_at INTEGER NOT NULL
    );`);
    sqlite.exec('COMMIT');
  } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
}

// Turso stores every write remotely. There is no local replica to lose when a
// free Render instance sleeps. The same adapter can use disposable local libSQL
// files for regression tests; Render configuration never permits file URLs.
export class LibsqlDatabase {
  constructor(url, authToken) {
    const parsed = new URL(url);
    if (!['libsql:', 'https:', 'file:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid Turso database URL.');
    if (parsed.protocol === 'file:' && process.env.RENDER) throw new Error('Render requires remote Turso storage.');
    if (parsed.protocol !== 'file:' && !authToken) throw new Error('TURSO_AUTH_TOKEN is required.');
    this.client = createClient({url, authToken, intMode:'number', timeout:5000,
      // Bound HTTP calls, including health checks, without automatic write retries.
      fetch: (request, init = {}) => fetch(request, {...init, signal:AbortSignal.any([...(init.signal ? [init.signal] : []), ...(request.signal ? [request.signal] : []), AbortSignal.timeout(10000)])}),
    });
  }
  prepare(sql) { return new LibsqlStatement(this, sql); }
  async batch(statements) {
    if (!statements.every(statement => statement instanceof LibsqlStatement && statement.database === this)) throw new Error('Invalid batch statement');
    if (!statements.length) return [];
    const started = performance.now();
    const expanded = statements.flatMap(statement => [
      'SELECT total_changes() AS n', {sql:statement.sql, args:statement.values},
      'SELECT total_changes() AS n, last_insert_rowid() AS row_id',
    ]);
    // One backend transaction owns all statements and their metadata. A failed
    // assertion rolls back route/ledger/invitation writes and audit rows together.
    const results = await this.client.batch(expanded, 'write');
    return statements.map((_, index) => {
      const before=results[index*3], result=results[index*3+1], after=results[index*3+2];
      return libsqlResult(result, performance.now()-started, after.rows[0].n-before.rows[0].n, after.rows[0].row_id);
    });
  }
  close() { this.client.close(); }
}
function libsqlResult(result, duration, changes=result.rowsAffected, rowId=result.lastInsertRowid) {
  const results=result.rows.map(row => Object.fromEntries(result.columns.map(name=>[name,row[name]])));
  return {success:true, results, meta:{changes, last_row_id:rowId == null ? 0 : Number(rowId), duration}};
}
class LibsqlStatement {
  constructor(database, sql, values=[]) { this.database=database; this.sql=sql; this.values=values; }
  bind(...values) { return new LibsqlStatement(this.database,this.sql,values); }
  async first(column) {
    const row=(await this.all()).results[0] ?? null;
    if (column && row && !(column in row)) throw new Error('Unknown result column');
    return column ? row?.[column] ?? null : row;
  }
  async all() {
    // libSQL's local client reports zero rowsAffected for UPDATE RETURNING.
    // Read the actual connection change counters for writes, on the same
    // transaction, rather than inferring success from returned row counts.
    if (!/^\s*(?:SELECT|EXPLAIN)\b/i.test(this.sql)) return (await this.database.batch([this]))[0];
    const started=performance.now();
    return libsqlResult(await this.database.client.execute({sql:this.sql,args:this.values}),performance.now()-started);
  }
  async run() { return this.all(); }
  async raw(options={}) {
    const result=await this.database.client.execute({sql:this.sql,args:this.values});
    const rows=result.rows.map(row=>result.columns.map(name=>row[name]));
    return options.columnNames ? [result.columns,...rows] : rows;
  }
}
export async function migrateLibsql(database, directory=resolve('drizzle')) {
  const client=database.client;
  await client.execute('CREATE TABLE IF NOT EXISTS render_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const name of readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort()) {
    const sql=readFileSync(resolve(directory,name),'utf8');
    const hash=createHash('sha256').update(sql).digest('hex');
    // One migration and its tracker row commit atomically. Existing hashes are
    // rechecked under the write lock so two startups cannot apply the same SQL.
    const tx=await client.transaction('write');
    try {
      const existing=(await tx.execute({sql:'SELECT sha256 FROM render_migrations WHERE name=?',args:[name]})).rows[0];
      if (existing) { if (existing.sha256 !== hash) throw new Error('An applied migration was changed.'); }
      else {
        await tx.executeMultiple(sql);
        await tx.execute({sql:'INSERT INTO render_migrations VALUES (?,?,?)',args:[name,hash,new Date().toISOString()]});
      }
      await tx.commit();
    } catch (error) { await tx.rollback().catch(()=>{}); throw error; }
    finally { tx.close(); }
  }
  await client.batch([
    'CREATE TABLE IF NOT EXISTS render_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,email TEXT NOT NULL,full_name TEXT,expires_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS render_sessions_expiry ON render_sessions(expires_at)',
    'CREATE TABLE IF NOT EXISTS render_login_attempts (state_hash TEXT PRIMARY KEY,nonce TEXT NOT NULL,verifier TEXT NOT NULL,return_to TEXT NOT NULL,expires_at INTEGER NOT NULL)',
  ],'write');
}
const databaseKey = Symbol.for('my-jamaat.render.database');
export function getDatabase() {
  if (!globalThis[databaseKey]) {
    const database = process.env.TURSO_DATABASE_URL
      ? new LibsqlDatabase(process.env.TURSO_DATABASE_URL,process.env.TURSO_AUTH_TOKEN)
      : new SqliteDatabase(process.env.SQLITE_PATH);
    if (database instanceof LibsqlDatabase) database.ready=migrateLibsql(database).catch(error=>{database.close();throw error;});
    else { try { migrate(database); } catch (error) { database.close(); throw error; } }
    globalThis[databaseKey] = database;
  }
  return globalThis[databaseKey];
}

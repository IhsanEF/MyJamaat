import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

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
const databaseKey = Symbol.for('my-jamaat.render.database');
export function getDatabase() {
  if (!globalThis[databaseKey]) {
    const database = new SqliteDatabase(process.env.SQLITE_PATH);
    try { migrate(database); } catch (error) { database.close(); throw error; }
    globalThis[databaseKey] = database;
  }
  return globalThis[databaseKey];
}

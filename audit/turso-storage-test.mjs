// Destructive probes use disposable local libSQL files only. Never live Turso.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LibsqlDatabase,migrateLibsql} from '../runtime/render/database.mjs';
const directory=mkdtempSync(join(tmpdir(),'my-jamaat-turso-storage-'));
const db=new LibsqlDatabase(`file:${join(directory,'storage.sqlite')}`);
const other=new LibsqlDatabase(`file:${join(directory,'other.sqlite')}`);
const checks=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
try {
  await db.prepare('CREATE TABLE probe(id INTEGER PRIMARY KEY,value TEXT UNIQUE)').run();
  await db.prepare('CREATE TABLE log(value TEXT)').run();
  await db.prepare('CREATE TRIGGER probe_log AFTER INSERT ON probe BEGIN INSERT INTO log VALUES (NEW.value); END').run();
  const written=await db.batch([db.prepare('INSERT INTO probe VALUES (?,?) RETURNING id').bind(1,'one')]);
  check('batch metadata includes returned rows and trigger writes',written[0].results[0].id===1&&written[0].meta.changes===2);
  await assert.rejects(()=>db.batch([db.prepare('INSERT INTO probe VALUES (?,?)').bind(2,'two'),db.prepare('INSERT INTO probe VALUES (?,?)').bind(3,'one')]));
  check('failed batch rolls back both primary rows and trigger writes',(await db.prepare('SELECT COUNT(*) AS n FROM probe').first('n'))===1&&(await db.prepare('SELECT COUNT(*) AS n FROM log').first('n'))===1);
  await assert.rejects(()=>db.batch([other.prepare('SELECT 1')]));
  check('foreign connection statements rejected',true);
  const migrations=join(directory,'migrations');mkdirSync(migrations);
  writeFileSync(join(migrations,'0000_probe.sql'),'CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES (\'original\');');
  await migrateLibsql(db,migrations);
  writeFileSync(join(migrations,'0001_failure.sql'),'CREATE TABLE should_rollback (value TEXT); INSERT INTO missing_table VALUES (1);');
  await assert.rejects(()=>migrateLibsql(db,migrations));
  check('failed migration rolls back its DDL',(await db.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback'").first())===null);
  check('failed migration does not advance tracker',(await db.prepare('SELECT COUNT(*) AS n FROM render_migrations').first('n'))===1);
  check('failed forward migration preserves existing data',(await db.prepare('SELECT value FROM preserved').first('value'))==='original');
  writeFileSync(join(migrations,'0000_probe.sql'),'DROP TABLE preserved;');
  await assert.rejects(()=>migrateLibsql(db,migrations),/applied migration was changed/);
  check('changed historical migration rejected without applying',(await db.prepare('SELECT value FROM preserved').first('value'))==='original');
  for (const url of ['http://example.test','ws://example.test','libsql://user:secret@example.test','https://example.test?tls=0']) assert.throws(()=>new LibsqlDatabase(url,'synthetic'));
  assert.throws(()=>new LibsqlDatabase('libsql://example.test'));
  check('unsafe URLs and missing remote token rejected',true);
  const render=process.env.RENDER;process.env.RENDER='true';
  try {assert.throws(()=>new LibsqlDatabase(`file:${join(directory,'denied.sqlite')}`));check('Render cannot use ephemeral file storage as Turso',true);}
  finally {if(render===undefined)delete process.env.RENDER;else process.env.RENDER=render;}
  writeFileSync('audit/turso-storage-verification.json',JSON.stringify({status:'PASS',scope:'Official libSQL client on disposable local SQLite; live cloud transport pending',checks},null,2)+'\n');
  console.log(`${checks.length} Turso storage checks passed`);
} finally {db.close();other.close();rmSync(directory,{recursive:true,force:true});}

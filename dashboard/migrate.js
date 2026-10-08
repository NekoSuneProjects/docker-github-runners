'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite');
const dbPath=process.env.DASHBOARD_DB_FILE||'/data/dashboard.sqlite';
fs.mkdirSync(path.dirname(dbPath),{recursive:true});
const db=new DatabaseSync(dbPath);
const migrations=[
 {id:1,name:'node fleet inventory',run(){
   const nodes=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'").get();
   if(nodes){
     const cols=new Set(db.prepare('PRAGMA table_info(nodes)').all().map(r=>r.name));
     if(!cols.has('fleet_runners_json'))db.exec("ALTER TABLE nodes ADD COLUMN fleet_runners_json TEXT NOT NULL DEFAULT '[]'");
   }
 }}
];
async function main(){
 try{
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec('CREATE TABLE IF NOT EXISTS neko_schema_migrations (id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  const applied=new Set(db.prepare('SELECT id FROM neko_schema_migrations').all().map(x=>x.id));
  const pending=migrations.filter(m=>!applied.has(m.id));
  if(!pending.length){console.log('[migrations] schema current; existing data preserved');return}
  if(fs.existsSync(dbPath)&&fs.statSync(dbPath).size){
   const dir=path.join(path.dirname(dbPath),'migration-backups');
   fs.mkdirSync(dir,{recursive:true});
   const filename=path.join(dir,path.basename(dbPath)+'.'+new Date().toISOString().replace(/[:.]/g,'-')+'.bak');
   await backup(db,filename);
   console.log('[migrations] created SQLite-consistent backup at '+filename);
  }
  for(const m of pending){
   db.exec('BEGIN IMMEDIATE');
   try{
    m.run();
    db.prepare('INSERT INTO neko_schema_migrations(id,name,applied_at) VALUES(?,?,?)').run(m.id,m.name,new Date().toISOString());
    db.exec('COMMIT');
    console.log('[migrations] applied '+m.id+' '+m.name);
   }catch(e){db.exec('ROLLBACK');throw e}
  }
  console.log('[migrations] completed safely');
 }finally{db.close()}
}
main().catch(e=>{console.error('[migrations] failed; dashboard startup aborted: '+e.stack);process.exitCode=1});

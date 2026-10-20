"use strict";
const fs = require("fs");
const path = require("path");
const dbPath = process.env.MORIBASE_TEST_DB || path.join(__dirname,"..","data","moribase.db");
if (!fs.existsSync(dbPath)) { console.error("DB not found:",dbPath); process.exit(1); }
let Database;
try { Database=require("better-sqlite3"); }
catch(e) { console.error("better-sqlite3 is not installed:",e.message); process.exit(1); }
const db=new Database(dbPath,{readonly:true,fileMustExist:true});
try {
  const tables=["facilities","classes","weekly_plans","weekly_plan_days"];
  for(const table of tables) {
    const found=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if(!found) throw Error("Missing table: "+table);
    console.log(table,db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  }
  console.log("You facility:",db.prepare("SELECT facility_id,facility_name FROM facilities WHERE facility_code='y'").all());
  console.log("You classes:",db.prepare("SELECT c.class_id,c.class_name FROM classes c JOIN facilities f ON f.facility_id=c.facility_id WHERE f.facility_code='y'").all());
  console.log("integrity:",db.pragma("integrity_check",{simple:true}));
  console.log("foreign key errors:",db.pragma("foreign_key_check").length);
  console.log("DB checked (READ-ONLY).",dbPath);
} catch(err) { console.error("DB CHECK ERROR:",err.message); process.exitCode=1; }
finally { db.close(); }

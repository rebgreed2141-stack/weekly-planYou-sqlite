"use strict";
// Writes only to a temporary SQLite backup; the original DB is never written by this test.
const fs=require("fs"), os=require("os"),path=require("path"),assert=require("node:assert/strict"),http=require("node:http");
const Database=require("better-sqlite3");
const source=process.env.MORIBASE_TEST_DB||path.join(__dirname,"..","data","moribase.db");
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"weekly-sqlite-test-"));
const copy=path.join(temp,"verify.db");
let server;
(async()=>{
 const db=new Database(source,{readonly:true,fileMustExist:true});
 try {await db.backup(copy);} finally {db.close();}
 const {makeHandler}=require("../lib/weekly-plan-test");
 const handle=makeHandler({dbPath:copy,logError:(label,err)=>console.error(label,err)});
 server=http.createServer(async(req,res)=>{await handle(req,res,new URL(req.url,"http://localhost"));});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base=`http://127.0.0.1:${server.address().port}/api/weekly-plan-test`;
 async function call(method,path,body,token="") {
  const r=await fetch(base+path,{method,headers:{"Content-Type":"application/json","X-Lock-Token":token},
     ...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,result:await r.json()};
 }
 const qs="?startDate=2026-08-31&classKey="+encodeURIComponent("かもしか");
 const before=await call("GET","/week"+qs);assert.equal(before.status,200);
 const key={classKey:"かもしか",startDate:"2026-08-31"};
 const lock=await call("POST","/lock",{...key,clientId:"test1",deviceName:"test device 1"});assert.equal(lock.status,200);
 const blocked=await call("POST","/lock",{...key,clientId:"test2",deviceName:"test device 2"});assert.equal(blocked.status,423);
 const data=before.result.data||{...key,weeklyAim:"",childAppearance:"",events:"",parentSupport:"",childReflection:"",selfEvaluation:"",journal:Array.from({length:6},()=>({}))};
 const saved=await call("POST","/week",{...data,weeklyAim:"SQLite safe test",baseRevision:before.result.revision},lock.result.token);
 assert.equal(saved.status,200);
 const stale=await call("POST","/week",{...data,baseRevision:before.result.revision},lock.result.token);assert.equal(stale.status,409);
 const loaded=await call("GET","/week"+qs);assert.equal(loaded.result.data.weeklyAim,"SQLite safe test");
 console.log("SELF-TEST PASSED: read, single editor, write, conflict, read again. Only temp DB modified.");
})().catch(e=>{console.error("SELF-TEST FAILED:",e);process.exitCode=1})
.finally(async()=>{if(server) await new Promise(done=>server.close(done));fs.rmSync(temp,{recursive:true,force:true})});

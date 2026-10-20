"use strict";
const base=(process.env.TEST_API_BASE||"http://localhost:3000")+"/api/weekly-plan-test";
(async()=>{
  const ping=await fetch(base+"/ping");if(!ping.ok)throw Error(`ping returned ${ping.status}`);
  console.log("ping:",await ping.json());
  const r=await fetch(base+"/weeks");if(!r.ok)throw Error(`weeks returned ${r.status}`);
  const rows=await r.json();
  console.log("You weekly plans:",rows.items?.length ?? "?");
  console.log("API read test completed (no data changed).");
})().catch(err=>{console.error("API test failed:",err.message);process.exitCode=1;});

import { pathToFileURL } from "node:url";
import { readFile, access } from "node:fs/promises";
import path from "node:path";

const project = path.resolve(process.argv[2]);
const stage = process.argv[3];
const checks = [];
const check = async (id, fn) => {
  try { const value = await fn(); checks.push({ id, pass: value !== false }); }
  catch (error) { checks.push({ id, pass: false, error: error?.message || String(error) }); }
};
const api = await import(`${pathToFileURL(path.join(project, "src/eval-api.mjs")).href}?t=${Date.now()}`);
const shift = (id, start, end, capacity=2, open=true) => ({ id, title:id, startsAt:start, endsAt:end, capacity, open });
const base = () => {
  let s=api.createInitialState();
  s=api.createShift(s,shift("S1","2026-10-01T09:00:00Z","2026-10-01T11:00:00Z",1,true));
  s=api.createShift(s,shift("S2","2026-10-01T10:00:00Z","2026-10-01T12:00:00Z",2,true));
  s=api.createShift(s,shift("S3","2026-10-01T12:00:00Z","2026-10-01T14:00:00Z",2,true));
  return s;
};
const claims = s => Array.isArray(s.claims) ? s.claims : Object.entries(s.claims || {}).flatMap(([userId,v]) => Array.isArray(v) ? v.map(shiftId=>({userId,shiftId})) : [{userId,shiftId:v}]);
await check("C01-artifacts", async()=>{ for (const f of ["index.html","src/eval-api.mjs"]) await access(path.join(project,f)); return true; });
await check("C02-create-validation", ()=>{ const s=api.createInitialState(); try { api.createShift(s,shift("X","2026-10-01T11:00:00Z","2026-10-01T10:00:00Z")); return false; } catch { return JSON.stringify(s)===JSON.stringify(api.createInitialState()); } });
await check("C03-capacity", ()=>{ let s=base(); s=api.claimShift(s,"U1","S1"); try { api.claimShift(s,"U2","S1"); return false; } catch { return claims(s).length===1; } });
await check("C04-closed", ()=>{ let s=api.createInitialState(); s=api.createShift(s,shift("X","2026-10-01T09:00:00Z","2026-10-01T10:00:00Z",2,false)); try { api.claimShift(s,"U1","X"); return false; } catch { return claims(s).length===0; } });
await check("C05-roundtrip", ()=>{ let s=base(); s=api.claimShift(s,"U1","S1"); return JSON.stringify(api.deserializeState(api.serializeState(s)))===JSON.stringify(s); });
if(stage==="v1") {
  await check("V1-global-unique", ()=>{ let s=base(); s=api.claimShift(s,"U1","S1"); try { api.claimShift(s,"U1","S3"); return false; } catch { return claims(s).length===1; } });
} else {
  await check("V2-non-overlap", ()=>{ let s=base(); s=api.claimShift(s,"U1","S1"); s=api.claimShift(s,"U1","S3"); return claims(s).filter(x=>x.userId==="U1").length===2; });
  await check("V2-overlap-rejected", ()=>{ let s=base(); s=api.claimShift(s,"U1","S1"); try { api.claimShift(s,"U1","S2"); return false; } catch { return claims(s).length===1; } });
  await check("V2-duplicate-rejected", ()=>{ let s=base(); s=api.claimShift(s,"U1","S1"); try { api.claimShift(s,"U1","S1"); return false; } catch { return claims(s).length===1; } });
  await check("V2-migration", ()=>{ const raw=JSON.stringify({schemaVersion:1,shifts:[shift("S1","2026-10-01T09:00:00Z","2026-10-01T11:00:00Z")],claims:{U1:"S1"}}); const s=api.deserializeState(raw); return claims(s).some(x=>x.userId==="U1"&&x.shiftId==="S1") && (s.schemaVersion??2)>=2; });
}
await check("DOC-prd", async()=>{ const candidates=["product/prd.md","docs/PRD.md","PRD.md"]; for(const f of candidates){try{const t=await readFile(path.join(project,f),"utf8"); if(t.length>200)return true;}catch{}} return false;});
await check("DOC-prototype", async()=>{ for(const f of ["prototype/index.html","prototype.html"]){try{const t=await readFile(path.join(project,f),"utf8"); if(t.includes("ShiftLoop"))return true;}catch{}} return false;});
if(stage==="v2") await check("DOC-review-boundary", async()=>{ const files=["product/review.md","docs/review.md","REVIEW.md"]; for(const f of files){try{const t=(await readFile(path.join(project,f),"utf8")).toLowerCase(); if((t.includes("未知")||t.includes("unknown"))&&(t.includes("复盘")||t.includes("review")))return true;}catch{}} return false;});
const passed=checks.filter(x=>x.pass).length;
console.log(JSON.stringify({stage,passed,total:checks.length,pass:passed===checks.length,checks},null,2));
process.exitCode=passed===checks.length?0:1;

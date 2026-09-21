import { build } from '../../../node_modules/esbuild/lib/main.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const subject = resolve(process.argv[2]);
const output = process.argv[3] ? resolve(process.argv[3]) : null;
const scratch = resolve('temp/holdout-sla-20260921/scorer/.scratch');
await mkdir(scratch, { recursive: true });
const id = randomUUID();
const entry = join(scratch, `${id}.ts`);
const bundle = join(scratch, `${id}.mjs`);
await writeFile(entry, `export * from ${JSON.stringify(join(subject, 'src/domain/index.ts'))};\nexport * from ${JSON.stringify(join(subject, 'src/repository/index.ts'))};\n`);
await build({ entryPoints:[entry], outfile:bundle, bundle:true, platform:'node', format:'esm', logLevel:'silent' });
const api = await import(`${pathToFileURL(bundle).href}?v=${id}`);

class MemoryStorage {
  constructor(value=null){ this.value=value; this.writes=0; }
  getItem(key){ return key===api.STORAGE_KEY ? this.value : null; }
  setItem(key,value){ if(key===api.STORAGE_KEY){ this.value=value; this.writes++; } }
}
const clone = value => JSON.parse(JSON.stringify(value));
const checks=[];
async function check(id, title, fn){
  try { await fn(); checks.push({id,title,pass:true}); }
  catch(error){ checks.push({id,title,pass:false,error:error instanceof Error?error.message:String(error)}); }
}
function assert(condition,message){ if(!condition) throw new Error(message); }
function assertSame(a,b,message){ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error(`${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const v1State={ticketsById:{
  L1:{id:'L1',title:'旧紧急工单',priority:'urgent',status:'open',openedAt:'2026-02-01T00:00:00.000Z',dueAt:'2026-02-02T00:00:00.000Z'},
  L2:{id:'L2',title:'旧普通工单',priority:'standard',status:'closed',openedAt:'2026-02-03T05:00:00.000Z',dueAt:'2026-02-04T05:00:00.000Z'}
},ticketOrder:['L2','L1']};

await check('H-01','新紧急工单使用 4 个绝对小时',()=>{
 const s=api.initialState(); const r=api.createTicket(s,{id:'N1',title:'紧急',priority:'urgent',openedAt:'2026-03-08T01:30:00-05:00'});
 assert(r.ok,'创建失败'); assert(r.state.ticketsById.N1.dueAt==='2026-03-08T10:30:00.000Z',`dueAt=${r.state.ticketsById.N1.dueAt}`);
});
await check('H-02','新普通工单保持 24 个绝对小时',()=>{
 const r=api.createTicket(api.initialState(),{id:'N2',title:'普通',priority:'standard',openedAt:'2026-01-01T23:15:00+08:00'});
 assert(r.ok,'创建失败'); assert(r.state.ticketsById.N2.dueAt==='2026-01-02T15:15:00.000Z',`dueAt=${r.state.ticketsById.N2.dueAt}`);
});
await check('H-03','合法 V1 迁移逐字段保留旧工单与顺序',()=>{
 const db=new MemoryStorage(JSON.stringify({schemaVersion:1,state:v1State})); const loaded=new api.LocalStorageRepository(db).load();
 assertSame(loaded,v1State,'迁移改变旧数据');
});
await check('H-04','迁移后保存重载仍保留且写入新版 schema',()=>{
 const db=new MemoryStorage(JSON.stringify({schemaVersion:1,state:v1State})); const repo=new api.LocalStorageRepository(db); const loaded=repo.load(); repo.save(loaded);
 const snap=JSON.parse(db.value); assert(Number.isInteger(snap.schemaVersion)&&snap.schemaVersion>1,`schemaVersion=${snap.schemaVersion}`);
 assertSame(new api.LocalStorageRepository(db).load(),v1State,'重载改变旧数据');
});
await check('H-05','关闭工单保留截止时间且不改输入状态',()=>{
 const s=api.initialState(); const before=clone(s); const r=api.closeTicket(s,'T1'); assert(r.ok,'关闭失败');
 assert(r.state.ticketsById.T1.status==='closed','状态未关闭'); assert(r.state.ticketsById.T1.dueAt===s.ticketsById.T1.dueAt,'截止时间改变'); assertSame(s,before,'输入状态被修改');
});
await check('H-06','非法优先级失败并返回同一状态对象',()=>{
 const s=api.initialState(); const r=api.createTicket(s,{id:'BAD',title:'bad',priority:'vip',openedAt:'2026-01-01T00:00:00Z'});
 assert(!r.ok,'非法优先级成功'); assert(r.state===s,'失败未返回原对象');
});
await check('H-07','重复 ID 与非法时间均不产生修改',()=>{
 const s=api.initialState(); const duplicate=api.createTicket(s,{id:'T1',title:'x',priority:'standard',openedAt:'2026-01-01T00:00:00Z'});
 const badDate=api.createTicket(s,{id:'N3',title:'x',priority:'urgent',openedAt:'not-a-date'});
 assert(!duplicate.ok&&duplicate.state===s,'重复 ID 行为错误'); assert(!badDate.ok&&badDate.state===s,'非法时间行为错误');
});
await check('H-08','新旧工单持久化往返后语义不变',()=>{
 const old=clone(v1State); const made=api.createTicket(old,{id:'N4',title:'new urgent',priority:'urgent',openedAt:'2026-04-01T00:00:00Z'}); assert(made.ok,'创建失败');
 const db=new MemoryStorage(); const repo=new api.LocalStorageRepository(db); repo.save(made.state); const loaded=repo.load(); assertSame(loaded,made.state,'往返不一致');
 assert(loaded.ticketsById.L1.dueAt==='2026-02-02T00:00:00.000Z','旧截止时间改变'); assert(loaded.ticketsById.N4.dueAt==='2026-04-01T04:00:00.000Z','新截止时间错误');
});
await check('H-09','损坏快照回退并修复为新版有效快照',()=>{
 const db=new MemoryStorage('{bad'); const loaded=new api.LocalStorageRepository(db).load(); assert(api.isValidState(loaded),'回退状态无效');
 const snap=JSON.parse(db.value); assert(snap.schemaVersion>1,'修复快照不是新版'); assert(api.isValidState(snap.state),'修复快照状态无效');
});
const report={subject,pass:checks.every(c=>c.pass),passed:checks.filter(c=>c.pass).length,total:checks.length,checks};
if(output){ await mkdir(resolve(output,'..'),{recursive:true}); await writeFile(output,JSON.stringify(report,null,2)+'\n'); }
console.log(JSON.stringify(report,null,2));
process.exitCode=report.pass?0:1;

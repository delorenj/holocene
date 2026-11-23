import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from '../../../../apps/api/node_modules/fastify/fastify.js';
import { committedDeclaration, createProductsDirectory, defaultProductsDeps, registerProductsRoutes } from '../../../../apps/api/src/products.js';
const out=dirname(fileURLToPath(import.meta.url));
const root=await mkdtemp(join(process.env.TMPDIR!, 'holoc62-quality-'));
const repo=join(root,'registered');
const receiptPath=join(repo,'custom/pm/runtime/launch-dashboard.json');
const project={id:'quality-fixture',name:'Quality fixture',repoPath:repo,indexed:true,agents:[{id:'fixture-pm',role:'pm',roleDir:'custom/pm'}]};
const now=Date.parse('2026-11-23T00:00:00Z');
const recent='2026-11-22T20:00:00Z';
const validUrl='https://s3.delo.sh/projects/quality-fixture/2026-11-22/launch-dashboard/index.html';
const base=()=>({schema:'launch-dashboard/1',published:{url:validUrl,at:recent},items:[{id:'act',status:'open',verified_at:recent}],requirements:{'gp.fixture':{status:'owner',item:'act',verified_at:recent}},private:'REVIEW_FIXTURE_DO_NOT_SERIALIZE'});
const git=(...args:string[])=>execFileSync('git',['--no-replace-objects','-C',repo,...args],{encoding:'utf8',stdio:'pipe'}).trim();
const results:any[]=[];
async function get(label:string,body:unknown,customNow=now){
 await rm(receiptPath,{force:true});
 if(body!==undefined) await writeFile(receiptPath,JSON.stringify(body));
 const deps=defaultProductsDeps(async()=>({projects:[project]})); deps.now=()=>customNow;
 const app=Fastify(); registerProductsRoutes(app,createProductsDirectory(deps));
 try {
  const response=await app.inject({method:'GET',url:'/api/modules/products'});
  assert.equal(response.statusCode,200,label); assert.equal(response.headers['cache-control'],'no-store');
  assert.equal(response.body.includes('REVIEW_FIXTURE_DO_NOT_SERIALIZE'),false);
  assert.equal(response.body.includes(repo),false);
  const payload=response.json(); assert.equal(payload.products.length,1,label);
  const result={label,http:response.statusCode,product:payload.products[0]}; results.push(result); return result;
 } finally{await app.close();}
}
try {
 await mkdir(join(repo,'custom/pm/runtime'),{recursive:true});
 git('init');git('config','user.name','Review Fixture');git('config','user.email','review@example.invalid');
 await writeFile(join(repo,'.launch.yaml'),'mode: launch\n');git('add','--','.launch.yaml');git('commit','-m','review fixture');
 await writeFile(join(repo,'.launch.yaml'),'mode: steady\n');
 assert.equal((await committedDeclaration(project)).raw,'mode: launch');
 const normal=await get('control: known statuses with claimed recent observations',base());
 assert.equal(normal.product.launch.state,'attention');
 const empty=await get('DEFECT: both collections empty', {...base(),items:[],requirements:{}});
 assert.equal(empty.product.launch.state,'unknown');assert.equal(empty.product.launch.openActions,0);assert.equal(empty.product.launch.ownerBlockers,0);
 const missingGates=await get('DEFECT: absent gate entries produce owner blocker zero', {...base(),requirements:{}});
 assert.equal(missingGates.product.launch.ownerBlockers,0);
 const noEvidence=await get('DEFECT: done and met have no identity/evidence but are considered current', {...base(),items:[{status:'done',verified_at:recent}],requirements:{x:{status:'met',verified_at:recent}}});
 assert.equal(noEvidence.product.launch.state,'attention');assert.equal(noEvidence.product.launch.openActions,0);assert.equal(noEvidence.product.launch.ownerBlockers,0);
 const invalidDate='2026-02-30T20:00:00Z';
 const badTime=await get('DEFECT: impossible calendar date normalized to current observation', {...base(),items:[{status:'open',verified_at:invalidDate}],requirements:{x:{status:'owner',verified_at:invalidDate}}},Date.parse('2026-03-03T00:00:00Z'));
 assert.equal(badTime.product.launch.state,'attention');assert.equal(badTime.product.launch.observedAt,'2026-03-02T20:00:00.000Z');
 const noZone='2026-11-22T12:00:00';
 const zone=await get('timestamp with no timezone accepted in host timezone', {...base(),items:[{status:'open',verified_at:noZone}],requirements:{x:{status:'owner',verified_at:noZone}}});
 assert.equal(zone.product.launch.state,'attention');
 for(const [label,patch] of [
  ['partial missing observations',{items:[{status:'open',verified_at:null}]}],
  ['future observations',{items:[{status:'open',verified_at:'2099-01-01T00:00:00Z'}]}],
  ['oldest observation stale',{items:[{status:'open',verified_at:'2026-11-01T00:00:00Z'}]}],
  ['unknown item status',{items:[{status:'alien'}]}],
  ['invalid requirements array',{requirements:[]}],
  ['invalid item null',{items:[null]}],
  ['unknown requirement status',{requirements:{x:{status:'alien'}}}],
 ] as const){const r=await get(label,{...base(),...patch});assert.notEqual(r.product.launch.state,'attention',label);}
 const unavailable=await get('missing receipt still listed without scripts',undefined);
 assert.equal(unavailable.product.launch.state,'unknown');assert.equal(unavailable.product.launch.openActions,undefined);assert.equal(unavailable.product.destination,undefined);
 for(const url of ['javascript:alert(1)','https://s3.delo.sh.evil.test/projects/quality-fixture/launch-dashboard/index.html','https://s3.delo.sh/projects/quality-fixture/a/../launch-dashboard/index.html','https://s3.delo.sh/projects/quality-fixture/launch-dashboard/index.html?token=fixture']){
  const r=await get('unsafe URL rejected: '+url,{...base(),published:{url,at:recent}});assert.equal(r.product.destination,undefined);
 }
 async function special(label:string,setup:()=>Promise<void>){
  await rm(receiptPath,{force:true});await setup();
  const deps=defaultProductsDeps(async()=>({projects:[project]}));deps.now=()=>now;
  const app=Fastify();registerProductsRoutes(app,createProductsDirectory(deps));
  try{const start=performance.now();const r=await app.inject({method:'GET',url:'/api/modules/products'});assert.equal(r.statusCode,200);const p=r.json().products[0];assert.equal(p.destination,undefined);assert.equal(p.launch.state,'unknown');results.push({label,http:r.statusCode,elapsedMs:performance.now()-start,product:p});}finally{await app.close();}
 }
 await special('FIFO rejected without blocking',async()=>{execFileSync('mkfifo',[receiptPath]);});
 await special('symlink outside repository rejected',async()=>{await writeFile(join(root,'outside.json'),JSON.stringify(base()));await symlink(join(root,'outside.json'),receiptPath);});
 await special('oversized receipt rejected',async()=>{await writeFile(receiptPath,' '.repeat(128*1024+1));});
 await special('malformed JSON rejected',async()=>{await writeFile(receiptPath,'{"schema":');});
 // Exercise coalescing and invalidation with real reader, not a reimplementation.
 await rm(receiptPath,{force:true}); await writeFile(receiptPath,JSON.stringify(base()));
 let clock=now,calls=0;
 const deps=defaultProductsDeps(async()=>{calls++;return {projects:[project]};});deps.now=()=>clock;
 const app=Fastify();registerProductsRoutes(app,createProductsDirectory(deps));
 try{
  const [a,b]=await Promise.all([app.inject({method:'GET',url:'/api/modules/products'}),app.inject({method:'GET',url:'/api/modules/products'})]);assert.equal(calls,1);assert.deepEqual(a.json(),b.json());
  await writeFile(receiptPath,JSON.stringify({...base(),items:[{status:'done',verified_at:recent}]}));
  const cached=await app.inject({method:'GET',url:'/api/modules/products'});assert.equal(cached.json().products[0].launch.openActions,1);
  clock+=5001;const renewed=await app.inject({method:'GET',url:'/api/modules/products'});assert.equal(calls,2);assert.equal(renewed.json().products[0].launch.openActions,0);
  assert.equal((await app.inject({method:'POST',url:'/api/modules/products'})).statusCode,404);
  results.push({label:'cache coalesces, expires after 5s, and route remains read-only',calls,before:cached.json().products[0].launch,after:renewed.json().products[0].launch});
 }finally{await app.close();}
 await writeFile(join(out,'adversarial-results.json'),JSON.stringify({revision:'7e9c5d0cbbc3f92398c82afa7f893fab56be2d65',runAt:new Date().toISOString(),entrypoint:'actual registerProductsRoutes GET + defaultProductsDeps + committed Git fixture + real readPublication',results},null,2),{flag:'wx'});
 // Reuse the actual malformed GET output in an explicitly labelled browser fixture.
 await writeFile(join(out,'malformed-get-payload.json'),JSON.stringify({generatedAt:new Date(now).toISOString(),registry:{state:'ok',snapshotAt:new Date(now).toISOString(),ageSeconds:0},products:[empty.product,noEvidence.product].map((p,i)=>({...p,id:i?'no-evidence-fixture':'empty-fixture',name:i?'No-evidence review fixture':'Empty review fixture',destination:undefined})),issues:[]},null,2),{flag:'wx'});
 console.log(JSON.stringify({assertions:'passed; bug assertions confirm incorrect candidate output',cases:results.length,results:results.map(x=>({label:x.label,state:x.product?.launch?.state,counts:[x.product?.launch?.ownerBlockers,x.product?.launch?.openActions]}))},null,2));
}finally{await rm(root,{recursive:true,force:true});}

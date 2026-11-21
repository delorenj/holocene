import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root='/home/delorenj/code/33GOD/holocene/.worktrees/holoc-57-products-sidebar';
const out=join(root,'_bmad-output/implementation-artifacts/holoc-57/reviews/quality');
const scratch=await mkdtemp(join(process.env.TMPDIR,'holoc57-quality-receipts-'));
const repo=join(scratch,'repo'); await mkdir(repo); execFileSync('git',['-C',repo,'init'],{stdio:'pipe'});execFileSync('git',['-C',repo,'config','user.name','Quality fixture']);execFileSync('git',['-C',repo,'config','user.email','quality@example.invalid']);
await writeFile(join(repo,'.launch.yaml'),'mode: launch\n');execFileSync('git',['-C',repo,'add','.launch.yaml']);execFileSync('git',['-C',repo,'commit','-m','private quality fixture'],{stdio:'pipe'});
const {createProductsDirectory,defaultProductsDeps,registerProductsRoutes,readPublication}=await import(pathToFileURL(join(root,'apps/api/src/products.ts')).href);
const {default:Fastify}=await import(pathToFileURL(join(root,'apps/api/node_modules/fastify/fastify.js')).href);
const project={id:'fixture',name:'Receipt fixture',repoPath:repo,indexed:true,agents:[{id:'pm',role:'pm',roleDir:'roles/pm'}]};
const receiptPath=join(repo,'roles/pm/runtime/launch-dashboard.json');await mkdir(join(repo,'roles/pm/runtime'),{recursive:true});
const safe='https://s3.delo.sh/projects/fixture/2026-11-20/launch-dashboard/index.html';
const mk=(url=safe)=>({schema:'launch-dashboard/1',published:{url,at:'2026-11-20T22:00:00Z'},checkout:{key_ref:'op://FIXTURE_ONLY/NEVER_SERIALIZE'},source:'RAW_PRIVATE_SOURCE_FIXTURE_ONLY'});
const results=[];
async function read(){const app=Fastify(); registerProductsRoutes(app,createProductsDirectory(defaultProductsDeps(async()=>({projects:[project]})))); try{const r=await app.inject({method:'GET',url:'/api/modules/products'});assert.equal(r.statusCode,200);const d=r.json();assert.ok(!r.body.includes('op://'));assert.ok(!r.body.includes('RAW_PRIVATE_SOURCE'));assert.ok(!r.body.includes(repo));return {destination:d.products[0]?.destination,issue:d.products[0]?.issue,registry:d.registry.state};}finally{await app.close();}}
try{
 for(const [name,url,accepted] of [
 ['safe control',safe,true],['scheme','javascript:alert(1)',false],['http',safe.replace('https:','http:'),false],['host suffix',safe.replace('s3.delo.sh','s3.delo.sh.evil.invalid'),false],['userinfo',safe.replace('s3.delo.sh','fixture:fixture@s3.delo.sh'),false],['default port',safe.replace('s3.delo.sh','s3.delo.sh:443'),false],['literal dot',safe.replace('/2026-11-20/','/x/../2026-11-20/'),false],['encoded dot',safe.replace('/2026-11-20/','/%2e%2e/2026-11-20/'),false],['double encoding',safe.replace('/2026-11-20/','/%252e%252e/2026-11-20/'),false],['backslash',safe.replace('/2026-11-20/','/x\\../2026-11-20/'),false],['fragment',safe+'#x',false],['query',safe+'?fixture=only',false],['control newline',safe.replace('https:','https:\n'),false],['outside path','https://s3.delo.sh/other/launch-dashboard/index.html',false],['protocol relative',safe.replace('https:',''),false]
 ]){
  await writeFile(receiptPath,JSON.stringify(mk(url)));const observed=await read();assert.equal(Boolean(observed.destination),accepted,name);results.push({name,accepted,observed});
 }
 await writeFile(receiptPath,'x'.repeat(140000)); let start=Date.now();const big=await read();assert.equal(big.destination,undefined);results.push({name:'oversized receipt',elapsedMs:Date.now()-start,observed:big});
 await rm(receiptPath);execFileSync('mkfifo',[receiptPath]); start=Date.now();const fifo=await read();assert.equal(fifo.destination,undefined);results.push({name:'FIFO real GET',elapsedMs:Date.now()-start,observed:fifo});await rm(receiptPath);
 const outside=join(scratch,'outside.json');await writeFile(outside,JSON.stringify(mk()));await symlink(outside,receiptPath);const escaped=await read();assert.equal(escaped.destination,undefined);results.push({name:'outside symlink real GET',observed:escaped});await rm(receiptPath);
 const controlPath=join(repo,'inside.json'); await writeFile(controlPath,JSON.stringify(mk())); await symlink(controlPath,receiptPath);assert.equal((await read()).destination.href,safe);results.push({name:'contained symlink control',pass:true});await rm(receiptPath);await writeFile(receiptPath,JSON.stringify(mk()));
 // Race intermediate directory swaps with real fd containment. Outside data includes a marker;
 // both outcomes are valid: bounded rejection or opening the currently contained safe inode.
 const runtime=join(repo,'roles/pm/runtime'), parked=join(repo,'roles/pm/parked'), evil=join(scratch,'external-runtime');await mkdir(evil);await writeFile(join(evil,'launch-dashboard.json'),JSON.stringify({...mk(),outsideRaceMarker:true}));
 let stop=false, swaps=0;
 const swap=(async()=>{while(!stop){try{await rename(runtime,parked);await symlink(evil,runtime);await rm(runtime);await rename(parked,runtime);swaps++;}catch{try{await rm(runtime,{force:true});await rename(parked,runtime);}catch{}}}})();
 let successes=0,rejections=0,escapedReads=0;const startRace=Date.now();
 for(let i=0;i<160;i++){try{const d=await readPublication(project);successes++;if(d.outsideRaceMarker)escapedReads++;}catch{rejections++;}}
 stop=true;await swap;assert.equal(escapedReads,0);results.push({name:'intermediate directory swap race',trials:160,swaps,successes,rejections,escapedReads,elapsedMs:Date.now()-startRace,limit:'Probabilistic stress probe, not exhaustive race proof.'});
 await writeFile(join(out,'receipt-probes.json'),JSON.stringify({fixtureOnly:true,results},null,2));console.log(JSON.stringify(results,null,2));
}finally{await rm(scratch,{recursive:true,force:true});}

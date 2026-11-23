import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from '../../../../apps/api/node_modules/fastify/fastify.js';
import { createProductsDirectory, defaultProductsDeps, registerProductsRoutes } from '../../../../apps/api/src/products.js';

const tmp = await mkdtemp(join(process.env.TMPDIR!, 'holoc62-final-review-'));
const repo = join(tmp, 'project');
const receipt = join(repo, 'pm/runtime/launch-dashboard.json');
const now = Date.parse('2026-11-23T00:00:00Z');
const at = '2026-11-22T20:00:00Z';
const destination = 'https://s3.delo.sh/projects/fixture/2026-11-22/launch-dashboard/index.html';
const base = () => ({schema:'launch-dashboard/1',published:{url:destination,at},items:[{id:'action',status:'open',verified_at:at}],requirements:{x:{status:'owner',item:'action',verified_at:at}},private:'NEVER_SERIALIZE_FINAL_REVIEW'});
const project = {id:'fixture',name:'Fixture',repoPath:repo,indexed:true,agents:[{id:'pm',role:'pm',roleDir:'pm'}]};
const checks: {name:string;state:string;counts:boolean;observation:boolean;destination:boolean}[] = [];
async function probe(name:string, data:unknown, expected:'unknown'|'attention'|'stale', clock=now, zero=false) {
  if(data === undefined) await rm(receipt,{force:true}); else await writeFile(receipt,JSON.stringify(data));
  const deps = defaultProductsDeps(async()=>({projects:[project]})); deps.now=()=>clock;
  const app=Fastify(); registerProductsRoutes(app,createProductsDirectory(deps));
  try {
    const response=await app.inject({method:'GET',url:'/api/modules/products'});
    assert.equal(response.statusCode,200,name); assert.equal(response.headers['cache-control'],'no-store');
    assert.equal(response.body.includes('NEVER_SERIALIZE_FINAL_REVIEW'),false,name);
    assert.equal(response.body.includes(repo),false,name);
    const payload=response.json(); assert.equal(payload.registry.state,'ok',name);
    assert.deepEqual(payload.products.map((p:{id:string})=>p.id),['fixture'],name);
    const p=payload.products[0]; assert.equal(p.stage,'launch',name); assert.equal(p.launch.state,expected,name);
    if(expected==='unknown') {
      assert.equal(p.launch.openActions,undefined,name);assert.equal(p.launch.ownerBlockers,undefined,name);
      assert.equal(p.launch.observedAt,undefined,name);
      assert.match(p.launch.nextStep,/missing or incomplete/i,name);
    }
    if(zero) {assert.equal(p.launch.openActions,0,name);assert.equal(p.launch.ownerBlockers,0,name);assert.ok(p.launch.observedAt,name);}
    assert.equal(p.destination?.href,data===undefined?undefined:destination,name);
    checks.push({name,state:p.launch.state,counts:p.launch.openActions!==undefined||p.launch.ownerBlockers!==undefined,observation:!!p.launch.observedAt,destination:!!p.destination});
  }finally{await app.close();}
}
try {
  await mkdir(join(repo,'pm/runtime'),{recursive:true});
  const git=(...a:string[])=>execFileSync('git',['--no-replace-objects','-C',repo,...a],{encoding:'utf8',stdio:'pipe'}).trim();
  git('init');git('config','user.name','Final Review');git('config','user.email','review@example.invalid');
  await writeFile(join(repo,'.launch.yaml'),'mode: launch\n');git('add','--','.launch.yaml');git('commit','-m','fixture');
  await writeFile(join(repo,'.launch.yaml'),'mode: steady\n'); // current disk may not override committed launch
  await probe('Q1 empty collections',{...base(),items:[],requirements:{}},'unknown');
  await probe('Q1 no requirements',{...base(),requirements:{}},'unknown');
  await probe('Q1 missing items',{...base(),items:[]},'unknown');
  await probe('Q2 identity-less done and evidence-free met',{...base(),items:[{status:'done',verified_at:at}],requirements:{x:{status:'met',verified_at:at}}},'unknown');
  await probe('Q2 orphan owner',{...base(),requirements:{x:{status:'owner',item:'missing',verified_at:at}}},'unknown');
  await probe('Q2 hollow met',{...base(),items:[{id:'action',status:'done',evidence:'done',verified_at:at}],requirements:{x:{status:'met',evidence:'yes',verified_at:at}}},'unknown');
  await probe('Q2 missing agent reference',{...base(),requirements:{x:{status:'agent',verified_at:at}}},'unknown');
  await probe('Q2 missing na reason',{...base(),requirements:{x:{status:'na',verified_at:at}}},'unknown');
  await probe('Q3 impossible February 30',{...base(),items:[{id:'action',status:'open',verified_at:'2026-02-30T20:00:00Z'}],requirements:{x:{status:'owner',item:'action',verified_at:'2026-02-30T20:00:00Z'}}},'unknown',Date.parse('2026-03-03T00:00:00Z'));
  await probe('Q3 zone-less',{...base(),items:[{id:'action',status:'open',verified_at:'2026-11-15T21:00:00'}],requirements:{x:{status:'owner',item:'action',verified_at:'2026-11-15T21:00:00'}}},'unknown');
  await probe('Q3 future',{...base(),requirements:{x:{status:'owner',item:'action',verified_at:'2099-01-01T00:00:00Z'}}},'unknown');
  await probe('Q3 stale oldest valid observation',{...base(),requirements:{x:{status:'owner',item:'action',verified_at:'2026-11-01T00:00:00Z'}}},'stale');
  await probe('complete validated zero',{...base(),items:[{id:'action',status:'done',evidence:'https://example.invalid/receipt',verified_at:at}],requirements:{x:{status:'met',evidence:'https://example.invalid/gate',verified_at:'2026-11-22T15:00:00-05:00'}}},'attention',now,true);
  await probe('no PM receipt',undefined,'unknown');
  console.log(JSON.stringify({revision:'1b4deccc67f48986e0ebb8dba378841b9d159714',timezone:process.env.TZ??'host',entrypoint:'Fastify actual GET; committed Git declaration and on-disk receipt via default reader',cases:checks},null,2));
}finally{await rm(tmp,{recursive:true,force:true});}

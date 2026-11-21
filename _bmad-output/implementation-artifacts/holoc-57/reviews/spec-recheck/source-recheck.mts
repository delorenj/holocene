import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.cwd(), out=join(root,'_bmad-output/implementation-artifacts/holoc-57/reviews/spec-recheck');
const scratch=await mkdtemp(join(process.env.TMPDIR!,'holoc57-spec-recheck-'));
const repo=join(scratch,'invalid'), neighbor=join(scratch,'neighbor');
let registry:any; const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(registry));});
const results:any={candidate:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),fixtureOnly:true,modes:[],ids:[],replacement:null};
const git=(path:string,...args:string[])=>execFileSync('git',['-C',path,...args],{encoding:'utf8',stdio:'pipe'}).trim();
async function commit(path:string,raw:string){await writeFile(join(path,'.launch.yaml'),raw);git(path,'add','.launch.yaml');git(path,'commit','-m','private fixture');}
try {
  for(const path of [repo,neighbor]){await mkdir(path);git(path,'init');git(path,'config','user.email','fixture@example.invalid');git(path,'config','user.name','Fixture');await commit(path,'mode: launch\n');}
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.env.PJ_REGISTRY_URL=`http://127.0.0.1:${(server.address() as any).port}`;
  const {getRegisteredProjects}=await import(pathToFileURL(join(root,'apps/api/src/hub.ts')).href);
  const {createProductsDirectory,defaultProductsDeps,registerProductsRoutes,committedDeclaration}=await import(pathToFileURL(join(root,'apps/api/src/products.ts')).href);
  const {default:Fastify}=await import(pathToFileURL(join(root,'apps/api/node_modules/fastify/fastify.js')).href);
  const goodRow=(path:string,id:string)=>({repo_path:path,project_id:id});
  registry={projects:{invalid:goodRow(repo,'invalid'),neighbor:goodRow(neighbor,'neighbor')}};
  async function get(deps=defaultProductsDeps(getRegisteredProjects)){const app=Fastify();registerProductsRoutes(app,createProductsDirectory(deps));try{const response=await app.inject({method:'GET',url:'/api/modules/products'});return {status:response.statusCode,body:response.json()};}finally{await app.close();}}
  for(const raw of ['mode: [launch]\n','mode: [steady]\n','mode: [live]\n','mode: {toString: launch}\n','mode: null\n','mode: 123\n','mode: true\n','mode: {value: live}\n',"mode: ''\n"]){
    await commit(repo,raw);const {status,body}=await get();assert.equal(status,200,raw);assert.equal(body.registry.state,'ok',raw);assert.deepEqual(body.products.map((p:any)=>p.id),['neighbor'],raw);assert.deepEqual(body.issues.map((x:any)=>[x.id,x.state]),[['invalid','invalid']],raw);assert.equal(JSON.stringify(body.products).includes('"href":"/live"'),false,raw);
    results.modes.push({raw,status,products:body.products.map((p:any)=>p.id),issues:body.issues,pass:true});
  }
  await commit(repo,'mode: launch\n'); registry={projects:{invalid:goodRow(repo,'invalid')}};
  let now=1800000000000;const deps=defaultProductsDeps(getRegisteredProjects);deps.now=()=>now;
  const app=Fastify();registerProductsRoutes(app,createProductsDirectory(deps));
  const read=async()=>{const response=await app.inject({method:'GET',url:'/api/modules/products'});assert.equal(response.statusCode,200);return response.json();};
  try{
    const good=await read();assert.equal(good.registry.state,'ok');assert.deepEqual(good.products.map((p:any)=>p.id),['invalid']);
    for(const badId of [42,{},[],false,'']){
      registry={projects:{invalid:{repo_path:repo,project_id:badId}}}; const direct=await getRegisteredProjects(); assert.ok(direct.down,JSON.stringify(badId));
      const first=await get();assert.equal(first.status,200);assert.equal(first.body.registry.state,'down');assert.equal(first.body.registry.snapshotAt,undefined);assert.deepEqual(first.body.products,[]);
      now+=6000;const stale=await read();assert.equal(stale.registry.state,'down');assert.equal(stale.registry.snapshotAt,good.registry.snapshotAt);assert.equal(stale.registry.ageSeconds,(now-1800000000000)/1000);assert.deepEqual(stale.products.map((p:any)=>p.id),['invalid']);
      results.ids.push({badId,first:first.body,stale,pass:true});
    }
    registry={projects:{}};now+=6000;const empty=await read();assert.equal(empty.registry.state,'ok');assert.deepEqual(empty.products,[]);assert.notEqual(empty.registry.snapshotAt,good.registry.snapshotAt);results.empty=empty;
    registry={projects:{invalid:goodRow(repo,'invalid')}};now+=6000;const recovered=await read();assert.equal(recovered.registry.state,'ok');assert.deepEqual(recovered.products.map((p:any)=>p.id),['invalid']);results.recovered=recovered;
  }finally{await app.close();}
  const head=git(repo,'rev-parse','HEAD');await writeFile(join(repo,'.launch.yaml'),'mode: live\n');git(repo,'add','.launch.yaml');const replacement=git(repo,'commit-tree',git(repo,'write-tree'),'-m','replacement live');git(repo,'replace',head,replacement);
  assert.equal(git(repo,'show',`${head}:.launch.yaml`),'mode: live');assert.equal(git(repo,'--no-replace-objects','show',`${head}:.launch.yaml`),'mode: launch');
  const declared=await committedDeclaration({id:'invalid',name:'invalid',repoPath:repo,indexed:true});assert.equal(declared.commit,head);assert.equal(declared.raw,'mode: launch');
  const response=await get();assert.equal(response.status,200);assert.equal(response.body.products[0].stage,'launch');assert.equal(response.body.products[0].declaration.commit,head);
  results.replacement={head,replacement,raw:declared.raw,status:response.status,products:response.body.products,pass:true};
} catch(e){results.failure=String(e);throw e;} finally{await writeFile(join(out,'source-results.json'),JSON.stringify(results,null,2));server.close();await rm(scratch,{recursive:true,force:true});console.log(JSON.stringify({candidate:results.candidate,modes:results.modes.length,ids:results.ids.length,healthyEmpty:results.empty?.registry.state,recovered:results.recovered?.products.length,replacement:results.replacement?.pass,failure:results.failure??null}));}

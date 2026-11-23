import Fastify from '../../../../apps/api/node_modules/fastify/fastify.js';
import { createProductsDirectory, registerProductsRoutes } from '../../../../apps/api/src/products.js';
const app=Fastify();
const stamp='2026-11-15T21:00:00';
registerProductsRoutes(app,createProductsDirectory({
 now:()=>Date.parse('2026-11-23T00:00:00Z'),
 projects:async()=>({projects:[{id:'fixture',name:'Fixture',repoPath:'/unused-private-fixture',indexed:true}]}),
 declaration:async()=>({commit:'a'.repeat(40),raw:'mode: launch\n'}),
 receipt:async()=>({schema:'launch-dashboard/1',items:[{id:'a',status:'open',verified_at:stamp}],requirements:{x:{status:'owner',item:'a',verified_at:stamp}}})
}));
try{const r=await app.inject({method:'GET',url:'/api/modules/products'});console.log(JSON.stringify({zone:process.env.TZ,input:stamp,response:r.json().products[0].launch}));}finally{await app.close();}

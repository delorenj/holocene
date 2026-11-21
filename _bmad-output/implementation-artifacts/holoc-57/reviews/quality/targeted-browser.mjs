import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc57-browser-deps/node_modules/playwright/index.mjs';
const base = 'http://127.0.0.1:3107';
const out = '/home/delorenj/code/33GOD/holocene/.worktrees/holoc-57-products-sidebar/_bmad-output/implementation-artifacts/holoc-57/reviews/quality';
const browser = await chromium.launch({ headless: true, executablePath: '/home/delorenj/.local/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
try {
 for (const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:740}]) {
  const context = await browser.newContext({viewport,reducedMotion:'reduce'}); const page = await context.newPage();
  let writes = []; await context.route('**/*', route => { const req=route.request(); if (!['GET','HEAD','OPTIONS'].includes(req.method())) { writes.push({url:req.url(),method:req.method()}); return route.abort(); } return route.continue(); });
  const routeChecks = [];
  for (const route of ['/products?unrelated=keep&stage=live','/products/?stage=launch&unrelated=keep','/?view=projects&focus=earshot&extra=retained']) {
   await page.goto(base+route); await page.locator('.hub-shell').waitFor();
   if (route.includes('/products')) await page.locator('.product-row').first().waitFor();
   else await page.locator('.hub-navigation [aria-current="page"][href="/?view=projects"]').waitFor({state:'attached'});
   routeChecks.push({requested:route,url:page.url(),current:await page.locator('.hub-navigation [aria-current="page"]').getAttribute('href'),products:await page.locator('.product-row').count(),query:Object.fromEntries(new URL(page.url()).searchParams)});
   if (!route.includes('/products') && viewport.width>=900) {
    await page.locator('.hub-navigation a[href="/?view=agents"]').click(); assert.equal(new URL(page.url()).searchParams.get('extra'),'retained');
    await page.goBack(); assert.equal(new URL(page.url()).searchParams.get('focus'),'earshot');
   }
  }
  await page.goto(base+'/products'); await page.locator('[data-product-id="earshot"]').waitFor();
  if (viewport.width<900) {
   await page.getByRole('button',{name:'Menu',exact:true}).click();
   const dialog=page.getByRole('dialog');
   await dialog.getByRole('button',{name:'Workspace',exact:true}).click();
   const before = await dialog.getByRole('button',{name:'Workspace',exact:true}).getAttribute('aria-expanded');
   await page.keyboard.press('Escape'); await page.waitForFunction(()=>document.activeElement?.textContent==='Menu');
   await page.getByRole('button',{name:'Menu',exact:true}).click();
   const after = await page.getByRole('dialog').getByRole('button',{name:'Workspace',exact:true}).getAttribute('aria-expanded');
   results.push({name:'drawer state across reopen',viewport,before,after,notes:'Disclosure reset on unmount is not treated as a blocker; current ancestor is independently reopened.'});
   await page.setViewportSize({width:1100,height:900}); await page.getByRole('dialog').waitFor({state:'hidden'});
   assert.equal(await page.locator('body').getAttribute('data-scroll-locked'),null);
   await page.setViewportSize(viewport); await page.getByRole('button',{name:'Menu',exact:true}).click();
   await page.getByRole('dialog').getByRole('button',{name:'Workspace',exact:true}).click();
   await page.getByRole('dialog').getByRole('link',{name:'Projects',exact:true}).click();
   await page.waitForURL('**/?view=projects'); await page.waitForLoadState('domcontentloaded');
   await page.locator('.hub-navigation [aria-current="page"][href="/?view=projects"]').waitFor({state:'attached'});
   await page.getByRole('dialog').waitFor({state:'hidden'});
   await page.getByRole('button',{name:'Menu',exact:true}).click();
   assert.equal(await page.getByRole('dialog').getByRole('button',{name:/^Workspace/}).getAttribute('aria-expanded'),'true');
   await page.keyboard.press('Escape');
  }
  await page.goto(base+'/products'); await page.locator('[data-product-id="earshot"]').getByRole('link').click(); await page.getByRole('heading',{name:'Earshot',exact:true}).waitFor();
  const live=await page.locator('#hub-content').innerText(); assert.ok(live.includes('Earshot')); assert.ok(live.length>100);
  assert.deepEqual(writes,[]); results.push({name:'native-route-and-lifecycle-controls',viewport,routeChecks,live:{url:page.url(),earshotHeading:true,bodyTextLength:live.length},writeRequests:writes});
  await context.close();
 }
 // Explicit stale UI transition with labelled local fixture; real link evidence is separate.
 const context=await browser.newContext({viewport:{width:390,height:844}}); const page=await context.newPage(); let fail=false;
 await page.route('**/api/modules/products',async route=> fail ? route.fulfill({status:503,json:{error:'QUALITY FIXTURE ONLY'}}) : route.continue());
 await page.goto(base+'/products'); await page.locator('[data-product-id="tolt"]').waitFor(); fail=true;
 await page.getByRole('button',{name:'Refresh sources'}).click(); await page.getByText('Products API unavailable. Showing the last response.',{exact:false}).waitFor();
 assert.equal(await page.locator('.product-row').count(),4); results.push({name:'fixture-only HTTP outage retains dated last response',pass:true,rows:4});
 await page.screenshot({path:out+'/stale-api-phone.png',fullPage:true}); await context.close();
 await writeFile(out+'/targeted-browser.json',JSON.stringify(results,null,2)); console.log(JSON.stringify(results,null,2));
} finally {await browser.close();}

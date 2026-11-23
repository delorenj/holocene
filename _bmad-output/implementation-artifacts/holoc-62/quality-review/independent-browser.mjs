import assert from 'node:assert/strict';
import { chromium } from '/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc57-browser-deps/node_modules/playwright/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const out=dirname(fileURLToPath(import.meta.url));
const base='http://127.0.0.1:3162';
const fixture=JSON.parse(await readFile(join(out,'malformed-get-payload.json'),'utf8'));
const browser=await chromium.launch({headless:true,executablePath:'/home/delorenj/.local/bin/google-chrome',args:['--no-sandbox']});
const evidence={revision:'7e9c5d0cbbc3f92398c82afa7f893fab56be2d65',runAt:new Date().toISOString(),real:[],fixture:[],requests:[]};
try{
 for(const viewport of [{width:1440,height:1000},{width:320,height:740}]){
  const context=await browser.newContext({viewport,reducedMotion:'reduce'});const page=await context.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{const u=new URL(r.url());if(u.origin===base)evidence.requests.push({method:r.method(),path:u.pathname});});
  await page.goto(base+'/products?stage=launch');await page.locator('[data-product-id="tolt"] .product-state').waitFor();
  const nav=viewport.width<900?page.locator('.hub-drawer'):page.locator('.hub-navigation');
  if(viewport.width<900)await page.getByRole('button',{name:'Menu',exact:true}).click();
  const projects=nav.getByRole('button',{name:/^Projects/});
  assert.equal(await projects.getAttribute('aria-expanded'),'true');
  await projects.focus();await page.keyboard.press('Space');assert.equal(await projects.getAttribute('aria-expanded'),'false');
  assert.equal(await nav.getByRole('link',{name:'Launch mode products',exact:true}).isVisible(),false);
  await page.keyboard.press('Enter');assert.equal(await projects.getAttribute('aria-expanded'),'true');
  const controls=await projects.getAttribute('aria-controls');assert.equal(await page.locator(`[id="${controls}"]`).isVisible(),true);
  const links=await nav.locator(`[id="${controls}"] a`).evaluateAll(els=>els.map(el=>({text:el.textContent,href:el.getAttribute('href'),current:el.getAttribute('aria-current')})));
  assert.deepEqual(links.map(x=>x.text),['Live products','Launch mode products','All projects']);
  if(viewport.width<900){await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});}
  const launch=await page.locator('.product-row').evaluateAll(els=>els.map(el=>({id:el.getAttribute('data-product-id'),text:el.querySelector('.product-state')?.textContent,href:el.querySelector('.product-action')?.getAttribute('href')})));
  const m=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));assert.ok(m.document<=m.width&&m.body<=m.width);
  await page.screenshot({path:join(out,`independent-launch-${viewport.width}.png`),fullPage:true});
  const destinations=[];
  for(const id of ['greeninbetween','gruvato','tolt']){
   const a=page.locator(`[data-product-id="${id}"] .product-action`);const href=await a.getAttribute('href');
   const [popup]=await Promise.all([context.waitForEvent('page'),a.click()]);await popup.waitForLoadState('domcontentloaded');
   assert.equal(popup.url(),href);assert.equal(await popup.evaluate(()=>window.opener===null),true);
   destinations.push({id,url:popup.url(),title:await popup.title(),bodyLength:(await popup.locator('body').innerText()).length});
   assert.ok(destinations.at(-1).bodyLength>100);await popup.close();
  }
  evidence.real.push({viewport,links,launch,measurement:m,destinations,errors});assert.deepEqual(errors,[]);await context.close();
 }
 // Fixture body below came from the actual candidate GET against private on-disk malformed receipts.
 // It is not evidence of production or real dashboard destination behavior.
 for(const viewport of [{width:1440,height:1000},{width:320,height:740}]){
  const context=await browser.newContext({viewport});const page=await context.newPage();
  await page.route('**/api/modules/products',route=>route.fulfill({json:fixture}));
  await page.goto(base+'/products?stage=launch');await page.locator('[data-product-id="no-evidence-fixture"] .product-state').waitFor();
  const empty=await page.locator('[data-product-id="empty-fixture"] .product-state').innerText();
  const invalid=await page.locator('[data-product-id="no-evidence-fixture"] .product-state').innerText();
  assert.match(empty,/Readiness unknown · 0 owner-blocked gates · 0 open actions/);
  assert.match(invalid,/Needs attention · 0 owner-blocked gates · 0 open actions/);
  assert.ok(!invalid.includes('not verified current'));
  await page.screenshot({path:join(out,`malformed-get-render-${viewport.width}.png`),fullPage:true});
  evidence.fixture.push({viewport,entrypoint:'actual GET output replayed only to isolate UI rendering',empty,invalid});await context.close();
 }
 assert.deepEqual(evidence.requests.filter(x=>x.method!=='GET'),[]);
 await writeFile(join(out,'independent-browser-results.json'),JSON.stringify(evidence,null,2),{flag:'wx'});
 console.log(JSON.stringify({real:evidence.real.map(x=>({viewport:x.viewport,rows:x.launch.length,destinations:x.destinations,errors:x.errors})),fixture:evidence.fixture,localNonGETs:evidence.requests.filter(x=>x.method!=='GET')},null,2));
}finally{await browser.close();}

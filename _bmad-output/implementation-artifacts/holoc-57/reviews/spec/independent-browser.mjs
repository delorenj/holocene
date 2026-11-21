import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import('/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc57-browser-deps/node_modules/playwright/index.mjs');
const out = dirname(fileURLToPath(import.meta.url));
const base = 'http://127.0.0.1:3107';
const result = { candidate: '4d36eb9c237549c3ce6e0913b5960a47387c3001', timestamp: new Date().toISOString(), realViewports: [], routes: [], fixtures: [], auth: [] };
const browser = await chromium.launch({ executablePath: '/home/delorenj/.local/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
async function measure(page) { return page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, theme: document.querySelector('.hub-root')?.getAttribute('data-theme'), sidebarWidth: document.querySelector('.hub-navigation')?.getBoundingClientRect().width })); }
async function boundedTabTo(page, locator, max=30) {
  for (let i=0; i<max; i++) { await page.keyboard.press('Tab'); if (await locator.evaluate(el => el === document.activeElement)) return i+1; }
  throw Error(`Keyboard could not reach ${await locator.textContent()}`);
}
async function realProducts(page) { await page.goto(`${base}/products`); await page.locator('[data-product-id="tolt"]').waitFor(); }
try {
  for (const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:740}]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await context.newPage(); const errors=[]; const documents=[];
    context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
    context.on('response', r => { if (r.request().resourceType() === 'document') documents.push({url:r.url(), status:r.status()}); });
    await realProducts(page);
    const actual = await (await page.request.get(`${base}/api/modules/products`)).json();
    const current = actual.products.map(p => ({id:p.id,stage:p.stage,href:p.destination?.href}));
    assert.deepEqual(current.map(p => p.id).sort(), ['earshot','greeninbetween','gruvato','tolt']);
    assert.equal(await page.getByRole('heading',{name:'Preparing to launch',exact:true}).count(),1);
    assert.equal(await page.getByRole('heading',{name:'Live',exact:true}).count(),1);
    const captures=[];
    for (const theme of ['ledger','ledger-night']) {
      if (await page.locator('.hub-root').getAttribute('data-theme') !== theme) await page.getByRole('button',{name:/^Day$|^Night$/}).click();
      const m=await measure(page); assert.equal(m.scrollWidth,viewport.width); assert.equal(m.bodyWidth,viewport.width);
      const style=await page.locator('.hub-navigation').evaluate(el=>({background:getComputedStyle(el).backgroundColor,animation:getComputedStyle(el).animationName,transition:getComputedStyle(el).transitionDuration}));
      assert.equal(style.animation,'none'); assert.equal(style.transition,'0s');
      await page.screenshot({path:`${out}/independent-products-${viewport.width}-${theme}.png`,fullPage:true}); captures.push({...m,style});
    }
    await page.getByText('Lifecycle source issues (51)',{exact:true}).click();
    assert.ok((await page.locator('.products-issues li').count()) >= 1);
    const issueDisclosure={open:await page.locator('.products-issues').getAttribute('open'),count:await page.locator('.products-issues li').count()};
    await page.getByText('Lifecycle source issues (51)',{exact:true}).click();
    let keyboard;
    if(viewport.width<900) {
      await realProducts(page);
      const menu=page.getByRole('button',{name:'Menu',exact:true});
      const tabs=await boundedTabTo(page,menu); const focusStyle=await menu.evaluate(el=>({outline:getComputedStyle(el).outlineWidth,style:getComputedStyle(el).outlineStyle}));
      await page.keyboard.press('Enter'); const dialog=page.getByRole('dialog',{name:'Holocene navigation'}); await dialog.waitFor();
      const workspace=dialog.getByRole('button',{name:'Workspace',exact:true});
      await boundedTabTo(page,workspace); await page.keyboard.press('Enter'); assert.equal(await workspace.getAttribute('aria-expanded'),'true');
      const controls=await workspace.getAttribute('aria-controls'); assert.ok(await dialog.locator(`[id="${controls}"]`).isVisible());
      for(let i=0;i<30;i++){await page.keyboard.press(i%7===0?'Shift+Tab':'Tab'); assert.ok(await dialog.evaluate(el=>el.contains(document.activeElement)));}
      await page.screenshot({path:`${out}/independent-drawer-${viewport.width}.png`,fullPage:true});
      await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'}); await page.waitForFunction(()=>document.activeElement?.textContent==='Menu');
      keyboard={tabsToMenu:tabs,focusStyle,trapSteps:30,escapeDismissed:true,focusReturned:true,controls};
      await page.keyboard.press('Enter'); await dialog.waitFor();
      const liveSubset=dialog.getByRole('link',{name:'Live',exact:true}); await boundedTabTo(page,liveSubset); await page.keyboard.press('Enter');
      await page.waitForURL('**/products?stage=live'); await page.locator('[data-product-id="earshot"]').waitFor();
      assert.equal(await page.getByRole('dialog').count(),0);
    } else {
      assert.equal((await measure(page)).sidebarWidth,232);
      const nav=page.locator('.hub-navigation');
      await boundedTabTo(page,nav.getByRole('button',{name:'Workspace',exact:true})); await page.keyboard.press('Enter');
      assert.equal(await nav.getByRole('button',{name:'Workspace',exact:true}).getAttribute('aria-expanded'),'true');
      const style=await page.evaluate(()=>({tag:document.activeElement.tagName,outline:getComputedStyle(document.activeElement).outlineWidth,style:getComputedStyle(document.activeElement).outlineStyle}));
      assert.equal(style.outline,'2px'); assert.equal(style.style,'solid');
      keyboard={keyboardGroup:true,focusStyle:style};
      await nav.getByRole('link',{name:'Live',exact:true}).click(); await page.waitForURL('**/products?stage=live');
    }
    assert.equal(await page.locator('.product-row').count(),1);
    assert.equal(await page.locator('.hub-navigation a[aria-current="page"]').getAttribute('href'),'/products?stage=live');
    await page.getByRole('navigation',{name:'Product stages'}).getByRole('link',{name:'Preparing to launch',exact:true}).click();
    await page.locator('[data-product-id="tolt"]').waitFor(); assert.equal(await page.locator('.product-row').count(),3);
    await page.goBack(); await page.locator('[data-product-id="earshot"]').waitFor(); assert.equal(await page.locator('.product-row').count(),1);
    await page.goForward(); await page.locator('[data-product-id="tolt"]').waitFor(); assert.equal(await page.locator('.product-row').count(),3);
    await realProducts(page);
    const links=[];
    for (const id of ['tolt','greeninbetween','gruvato']) {
      const link=page.locator(`[data-product-id="${id}"] a`); const href=await link.getAttribute('href');
      const [destination]=await Promise.all([context.waitForEvent('page'),link.press('Enter')]);
      await destination.waitForLoadState('domcontentloaded'); assert.equal(destination.url(),href);
      const title=await destination.title(); const body=await destination.locator('body').innerText();
      const destinationViewport=await destination.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth})); assert.equal(destinationViewport.width,viewport.width);
      assert.ok(title.toLowerCase().includes(id)); assert.ok(body.length>1000); assert.ok(!title.toLowerCase().includes('sign in'));
      const openerNull=await destination.evaluate(()=>window.opener===null); assert.equal(openerNull,true);
      const referrer=await destination.evaluate(()=>document.referrer); assert.equal(referrer,'');
      await destination.screenshot({path:`${out}/independent-dashboard-${id}-${viewport.width}.png`});
      links.push({id,href,url:destination.url(),title,bodyCharacters:body.length,destinationViewport,openerNull,referrer}); await destination.close();
    }
    await page.locator('[data-product-id="earshot"] a').press('Enter'); await page.waitForURL('**/live');
    await page.getByRole('heading',{name:'Earshot',exact:true}).waitFor({timeout:45000});
    const live=await measure(page);assert.equal(live.scrollWidth,viewport.width);
    const liveText=await page.locator('main,[role="main"]').innerText(); assert.ok(liveText.includes('Earshot'));
    await page.screenshot({path:`${out}/independent-live-${viewport.width}.png`,fullPage:true});
    result.realViewports.push({viewport,current,issues:actual.issues.length,captures,issueDisclosure,keyboard,history:true,links,live:{url:page.url(),heading:'Earshot',...live},errors,documents});
    await context.close();
  }
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});const page=await context.newPage();
  await page.goto(`${base}/?view=projects&focus=earshot`); const nav=page.locator('.hub-navigation');
  await nav.locator('a[aria-current="page"]').filter({hasText:'Projects'}).waitFor();
  await page.getByRole('complementary',{name:'Selected project'}).getByRole('heading',{name:'Earshot',exact:true}).waitFor();
  const focusedProject={url:page.url(),selectedHeading:await page.getByRole('complementary',{name:'Selected project'}).getByRole('heading').first().innerText()};
  const project=nav.getByRole('link',{name:'Projects',exact:true});const modified=[];
  for(const options of [{modifiers:['Control']},{button:'middle'}]) {
    const [newPage]=await Promise.all([context.waitForEvent('page'),project.click(options)]); await newPage.waitForLoadState();
    modified.push({options,url:newPage.url(),originalURL:page.url()});assert.equal(new URL(page.url()).searchParams.get('focus'),'earshot');await newPage.close();
  }
  await nav.getByRole('link',{name:'Agents',exact:true}).press('Enter'); await nav.locator('a[aria-current="page"]').filter({hasText:'Agents'}).waitFor();
  await page.goBack(); await page.getByRole('complementary',{name:'Selected project'}).getByRole('heading',{name:'Earshot',exact:true}).waitFor();
  await page.goForward(); await nav.locator('a[aria-current="page"]').filter({hasText:'Agents'}).waitFor();
  result.hub={focusedProject,modified,backForward:true};
  for(const route of ['/artifacts','/candybar','/genesis','/settings','/transcripts','/voice','/wax','/mini','/hooks','/legacy']) {
    const response=await page.goto(`${base}${route}`); const record={route,status:response.status(),url:page.url(),shells:await page.locator('.hub-shell').count(),oldTabStrips:await page.locator('.hub-tabs').count(),currentHref:await page.locator('.hub-navigation a[aria-current="page"]').first().getAttribute('href').catch(()=>null),title:await page.title()};
    for(const width of [1440,390,320]){await page.setViewportSize({width,height:844});record[`width${width}`]=await measure(page);}
    result.routes.push(record);
  }
  await page.setViewportSize({width:320,height:740});
  const probes=JSON.parse(await readFile(`${out}/source-probes.json`,'utf8'));
  const fixtureList=[
    {id:'invalid-array-mode',payload:probes.payload,expect:'Invalid array mode fixture'},
    {id:'malformed-registry-false-empty',payload:probes.malformedAfterGoodPayload,expect:'No registered products declared launch.'},
    {id:'registry-first-failure',payload:{generatedAt:'2026-11-20T00:00:00Z',registry:{state:'down',detail:'PJ registry unavailable or invalid.'},products:[],issues:[]},expect:'No successful PJ snapshot is available.'},
    {id:'registry-last-good',payload:{generatedAt:'2026-11-20T00:00:06Z',registry:{state:'down',detail:'PJ registry unavailable or invalid.',snapshotAt:'2026-11-20T00:00:00Z',ageSeconds:6},products:[],issues:[{id:'missing',name:'Missing declaration fixture',state:'missing',detail:'No committed .launch.yaml; lifecycle is unknown.'}]},expect:'Last good PJ snapshot:'},
    {id:'healthy-empty',payload:{generatedAt:'2026-11-20T00:00:00Z',registry:{state:'ok',snapshotAt:'2026-11-20T00:00:00Z',ageSeconds:0},products:[],issues:[]},expect:'No registered products declared launch.'},
  ];
  for(const fixture of fixtureList) {
    await page.route('**/api/modules/products',route=>route.fulfill({json:fixture.payload})); await page.goto(`${base}/products`);await page.getByText(fixture.expect,{exact:false}).first().waitFor();
    const body=await page.locator('main').innerText();
    if(fixture.id==='invalid-array-mode'){assert.equal(await page.locator('[data-product-id="invalid-array-mode"] a').getAttribute('href'),'/live');}
    const m=await measure(page);assert.equal(m.scrollWidth,320);await page.screenshot({path:`${out}/fixture-${fixture.id}-320.png`,fullPage:true});
    result.fixtures.push({id:fixture.id,label:'SYNTHETIC browser payload; invalid-array-mode payload generated by actual candidate createProductsDirectory',body,...m});await page.unroute('**/api/modules/products');
  }
  await realProducts(page);await page.route('**/api/modules/products',route=>route.abort('failed'));await page.getByRole('button',{name:'Refresh sources',exact:true}).click();await page.getByText('Products API unavailable. Showing the last response.',{exact:false}).waitFor();
  result.fixtures.push({id:'retained-api-last-response',label:'SYNTHETIC failed API request after real successful response',products:await page.locator('.product-row').count(),message:await page.locator('.products-source').innerText()});
  await page.unroute('**/api/modules/products');await page.getByRole('button',{name:'Refresh sources',exact:true}).click();await page.getByText('PJ registry read',{exact:false}).waitFor();
  await context.close();
  const authContext=await browser.newContext();
  for(const path of ['/products','/api/modules/products']) {
    const response=await authContext.request.get(`https://holocene.delo.sh${path}`,{maxRedirects:0});const location=response.headers().location;const origin=location?new URL(location).origin:null;
    assert.equal(response.status(),307);assert.equal(origin,'https://accounts.google.com');result.auth.push({path,status:response.status(),redirectOrigin:origin,anonymous:true,candidateServingProven:false});
  }
  await authContext.close();
} catch(error) { result.failure={name:error.name,message:error.message,stack:error.stack};throw error; }
finally { await writeFile(`${out}/independent-browser-results.json`,JSON.stringify(result,null,2));await browser.close();console.log(JSON.stringify({viewports:result.realViewports.length,routes:result.routes.length,fixtures:result.fixtures.length,auth:result.auth,failure:result.failure},null,2)); }

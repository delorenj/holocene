import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const { chromium }=await import('/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc57-browser-deps/node_modules/playwright/index.mjs');
const out=dirname(fileURLToPath(import.meta.url));const base='http://127.0.0.1:3107';const results=[];
const browser=await chromium.launch({headless:true,executablePath:'/home/delorenj/.local/bin/google-chrome',args:['--no-sandbox']});
try{
 for(const width of [1440,390,320]){
  const ctx=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'});const page=await ctx.newPage();
  const agents=await (await ctx.request.get(`${base}/api/modules/hub/agents`)).json();const id=agents.agents.find(a=>a.id==='holocene-pm')?.id??agents.agents.find(a=>a.active)?.id??agents.agents[0].id;
  await page.goto(`${base}/?view=agents&focus=${encodeURIComponent(id)}`);await page.getByRole('complementary',{name:'Selected agent'}).waitFor();
  await page.locator('.hub-navigation a[aria-current="page"]').filter({hasText:'Agents'}).waitFor({state:'attached'});
  assert.equal(new URL(page.url()).searchParams.get('focus'),id);const selected=await page.getByRole('complementary',{name:'Selected agent'}).innerText();assert.ok(selected.includes(id));
  const report={width,agentFocus:id,agentFocusRendered:true,dimensions:await page.evaluate(()=>({viewport:innerWidth,html:document.documentElement.scrollWidth,body:document.body.scrollWidth})),themes:[]};
  assert.equal(report.dimensions.html,width);assert.equal(report.dimensions.body,width);
  if(width<900){
    const menu=page.getByRole('button',{name:'Menu',exact:true});
    for(const theme of ['ledger','ledger-night']){
      if(await page.locator('.hub-root').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/^Day$|^Night$/}).click();
      await menu.click();const dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal(await dialog.getByRole('button',{name:/Workspace/}).getAttribute('aria-expanded'),'true');
      const ancestor=await dialog.locator('.hub-nav-group.is-ancestor').textContent();assert.ok(ancestor.includes('current group'));
      const style=await dialog.evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color,animation:getComputedStyle(el).animationName,transition:getComputedStyle(el).transitionDuration,width:el.getBoundingClientRect().width}));assert.equal(style.animation,'none');assert.equal(style.transition,'0s');
      if(width===390) { await page.waitForTimeout(200); await page.mouse.click(350,100); } // Allow Radix's deferred outside-pointer listener to attach.
      if(width===320)await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.textContent==='Menu');
      report.themes.push({theme,style,ancestor,escapeOrOutsideDismissal:true,focusReturned:true});
    }
    await menu.click();const dialog=page.getByRole('dialog');await dialog.getByRole('link',{name:'Projects',exact:true}).press('Enter');await dialog.waitFor({state:'hidden'});
  }else await page.locator('.hub-navigation').getByRole('link',{name:'Projects',exact:true}).press('Enter');
  await page.locator('.hub-navigation a[aria-current="page"]').filter({hasText:'Projects'}).waitFor({state:'attached'});
  await page.goBack();await page.getByRole('complementary',{name:'Selected agent'}).waitFor();assert.equal(new URL(page.url()).searchParams.get('focus'),id);assert.ok((await page.getByRole('complementary',{name:'Selected agent'}).innerText()).includes(id));
  report.historyPreservedAgentFocus=true;
  await page.goto(`${base}/products`);await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Skip to content');await page.keyboard.press('Enter');assert.equal(await page.locator('#hub-content').evaluate(el=>el===document.activeElement),true);report.keyboardSkip=true;
  results.push(report);await ctx.close();
 }
}finally{await writeFile(`${out}/supplemental-navigation-results.json`,JSON.stringify(results,null,2));await browser.close();console.log(JSON.stringify(results,null,2));}

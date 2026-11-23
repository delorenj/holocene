import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
if (!process.env.PLAYWRIGHT_MODULE) throw Error("Set PLAYWRIGHT_MODULE to an ephemeral or installed Playwright index.mjs");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const base = process.env.PRODUCTS_TEST_URL ?? "http://127.0.0.1:3107";
const out = resolve(process.env.PRODUCTS_EVIDENCE_DIR ?? "../../_bmad-output/implementation-artifacts/holoc-57/browser");
await mkdir(out, { recursive: true });
const evidence = [];
async function browserTest(fn) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/home/delorenj/.local/bin/google-chrome", args: ["--no-sandbox"] });
  try { await fn(browser); } finally { await browser.close(); }
}
async function measure(page) {
  return page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, sidebar: document.querySelector(".hub-navigation")?.getBoundingClientRect().width, theme: document.querySelector(".hub-root")?.getAttribute("data-theme") }));
}
async function noOverflow(page) { const m = await measure(page); assert.ok(m.pageWidth <= m.viewport.width && m.bodyWidth <= m.viewport.width, JSON.stringify(m)); return m; }
function ratio(a, b) {
  const lum = (color) => { const values = color.trim().startsWith("#") ? color.trim().slice(1).match(/../g).map((x) => parseInt(x, 16)) : color.match(/[\d.]+/g).slice(0, 3).map(Number); const c = values.map((n) => { n /= 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }); return .2126*c[0] + .7152*c[1] + .0722*c[2]; };
  const x = lum(a), y = lum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}

test("real registered products: desktop and phone navigate every receipt dashboard and existing Earshot Live", { timeout: 180_000 }, async () => browserTest(async (browser) => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/products`);
    await page.locator('[data-product-id="tolt"]').waitFor();
    const rows = await page.locator(".product-row").count(); assert.equal(rows, 4);
    assert.equal(await page.getByRole("heading", { name: "Launch mode products", exact: true }).count(), 1);
    assert.equal(await page.getByRole("heading", { name: "Live products", exact: true }).count(), 1);
    const projectsParent = page.locator(viewport.width < 900 ? ".hub-drawer" : ".hub-navigation").getByRole("button", { name: /^Projects/ });
    if (viewport.width >= 900) {
      assert.equal(await projectsParent.count(), 1);
      await projectsParent.click();
      assert.equal(await projectsParent.getAttribute("aria-expanded"), "true");
      assert.equal(await page.locator(".hub-navigation").getByRole("link", { name: "All projects", exact: true }).getAttribute("href"), "/?view=projects");
      await projectsParent.click();
      assert.equal(await projectsParent.getAttribute("aria-expanded"), "false");
      await projectsParent.click();
    }
    for (const id of ["tolt", "greeninbetween", "gruvato"]) {
      const state = page.locator(`[data-product-id="${id}"] .product-state`);
      assert.equal(await state.count(), 1);
      assert.match(await state.innerText(), /Readiness unknown|Stale evidence|Needs attention/);
      assert.match(await state.innerText(), /Oldest recorded gate observation:/);
    }
    const captures = [];
    for (const theme of ["ledger", "ledger-night"]) {
      if (await page.locator(".hub-root").getAttribute("data-theme") !== theme) await page.getByRole("button", { name: /Day|Night/ }).click();
      const m = await noOverflow(page);
      const colors = await page.locator(".product-provenance").first().evaluate((el) => ({ text: getComputedStyle(el).color, background: getComputedStyle(el.closest(".product-row")).backgroundColor }));
      const contrast = ratio(colors.text, colors.background); assert.ok(contrast >= 4.5, JSON.stringify({ colors, contrast }));
      const navColors = await page.locator(".hub-navigation").evaluate((el) => { const style = getComputedStyle(el); return { text: style.getPropertyValue("--h-ink-2"), background: style.backgroundColor, focus: style.getPropertyValue("--h-pop") }; });
      const navContrast = ratio(navColors.text, navColors.background); assert.ok(navContrast >= 4.5);
      const focusContrast = ratio(navColors.focus, navColors.background); assert.ok(focusContrast >= 3);
      const motion = await page.locator(".hub-navigation").evaluate((el) => ({ animation: getComputedStyle(el).animationName, transition: getComputedStyle(el).transitionDuration }));
      assert.equal(motion.animation, "none"); assert.equal(motion.transition, "0s");
      await page.screenshot({ path: `${out}/products-${viewport.width}-${theme}.png`, fullPage: true }); captures.push({ ...m, contrast, navContrast, focusContrast, motion });
    }
    if (viewport.width < 900) {
      const menu = page.getByRole("button", { name: "Menu", exact: true }); await menu.focus(); await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Holocene navigation" }); await dialog.waitFor();
      await dialog.getByRole("button", { name: /^Projects/ }).focus(); await page.keyboard.press("Enter");
      assert.equal(await dialog.getByRole("button", { name: /^Projects/ }).getAttribute("aria-expanded"), "true");
      assert.equal(await dialog.getByRole("link", { name: "Live products", exact: true }).count(), 1);
      assert.equal(await dialog.getByRole("link", { name: "Launch mode products", exact: true }).count(), 1);
      await dialog.getByRole("button", { name: "Workspace", exact: true }).click();
      assert.equal(await dialog.getByRole("button", { name: "Workspace", exact: true }).getAttribute("aria-expanded"), "true");
      for (let i = 0; i < 22; i++) { await page.keyboard.press("Tab"); assert.ok(await dialog.evaluate((el) => el.contains(document.activeElement))); }
      await page.screenshot({ path: `${out}/drawer-${viewport.width}.png`, fullPage: true });
      await noOverflow(page); await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" }); await page.waitForFunction(() => document.activeElement?.textContent === "Menu"); assert.equal(await menu.evaluate((el) => el === document.activeElement), true);
      await menu.click(); await page.getByRole("dialog").getByRole("button", { name: /^Projects/ }).click(); await page.getByRole("dialog").getByRole("link", { name: "Launch mode products", exact: true }).click();
    } else {
      assert.equal((await measure(page)).sidebar, 232);
      await page.locator(".hub-navigation").getByRole("link", { name: "Launch mode products", exact: true }).click();
    }
    await page.waitForURL("**/products?stage=launch"); await page.locator('[data-product-id="tolt"]').waitFor();
    assert.equal(await page.locator(".product-row").count(), 3);
    await page.getByRole("navigation", { name: "Product stages" }).getByRole("link", { name: "Live products", exact: true }).click();
    await page.locator('[data-product-id="earshot"]').waitFor(); assert.equal(await page.locator(".product-row").count(), 1);
    await page.goBack(); await page.locator('[data-product-id="tolt"]').waitFor(); assert.equal(await page.locator(".product-row").count(), 3);
    await page.goForward(); await page.locator('[data-product-id="earshot"]').waitFor();
    await page.goto(`${base}/products`); await page.locator('[data-product-id="tolt"]').waitFor();
    const destinations = [];
    for (const id of ["tolt", "greeninbetween", "gruvato"]) {
      const action = page.locator(`[data-product-id="${id}"]`).getByRole("link"); const href = await action.getAttribute("href");
      assert.equal(await action.getAttribute("rel"), "noreferrer noopener");
      const [popup] = await Promise.all([page.waitForEvent("popup"), action.click()]);
      await popup.waitForLoadState("domcontentloaded");
      assert.equal(popup.url(), href); const title = await popup.title(); assert.match(title.toLowerCase(), new RegExp(id === "greeninbetween" ? "greeninbetween" : id));
      assert.ok((await popup.locator("body").innerText()).length > 100); assert.equal(await popup.evaluate(() => window.opener === null), true);
      await popup.screenshot({ path: `${out}/dashboard-${id}-${viewport.width}.png`, fullPage: false });
      destinations.push({ id, href, url: popup.url(), title }); await popup.close();
    }
    await page.locator('[data-product-id="earshot"]').getByRole("link").click(); await page.waitForURL("**/live");
    await page.getByRole("heading", { name: "Earshot", exact: true }).waitFor({ timeout: 45_000 });
    const liveMeasurement = await noOverflow(page);
    await page.screenshot({ path: `${out}/earshot-live-${viewport.width}.png`, fullPage: true });
    evidence.push({ viewport, captures, destinations, live: { url: page.url(), title: await page.title(), ...liveMeasurement }, pageErrors: errors });
    assert.deepEqual(errors, []); await context.close();
  }
  await writeFile(`${out}/real-navigation.json`, JSON.stringify(evidence, null, 2));
}));

test("hub focus/history/native modified links and shared specialist sidebar", { timeout: 120_000 }, async () => browserTest(async (browser) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${base}/?view=projects&focus=earshot`); await page.locator('.hub-navigation a[aria-current="page"]').filter({ hasText: "All projects" }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("focus"), "earshot");
  const projects = page.locator(".hub-navigation").getByRole("link", { name: "All projects", exact: true });
  const [popup] = await Promise.all([page.context().waitForEvent("page"), projects.click({ modifiers: ["Control"] })]); await popup.waitForLoadState(); assert.match(popup.url(), /view=projects/); await popup.close();
  assert.equal(new URL(page.url()).searchParams.get("focus"), "earshot");
  const [middle] = await Promise.all([page.context().waitForEvent("page"), projects.click({ button: "middle" })]); await middle.waitForLoadState(); assert.match(middle.url(), /view=projects/); await middle.close();
  await page.locator(".hub-navigation").getByRole("link", { name: "Agents", exact: true }).focus();
  await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
  const focusStyle = await page.locator(".hub-navigation").getByRole("link", { name: "Agents", exact: true }).evaluate((el) => ({ width: getComputedStyle(el).outlineWidth, style: getComputedStyle(el).outlineStyle }));
  assert.ok(parseFloat(focusStyle.width) >= 2); assert.equal(focusStyle.style, "solid");
  await page.locator(".hub-navigation").getByRole("link", { name: "Agents", exact: true }).click(); assert.equal(new URL(page.url()).searchParams.get("view"), "agents");
  await page.goBack(); assert.equal(new URL(page.url()).searchParams.get("focus"), "earshot"); await page.locator('.hub-navigation a[aria-current="page"]').filter({ hasText: "All projects" }).waitFor();
  await page.goForward(); await page.locator('.hub-navigation a[aria-current="page"]').filter({ hasText: "Agents" }).waitFor();
  for (const route of ["/artifacts", "/candybar", "/genesis", "/settings", "/transcripts", "/voice", "/wax"]) {
    await page.goto(`${base}${route}`); assert.equal(await page.locator(".hub-shell").count(), 1); assert.equal(await page.locator(".hub-tabs").count(), 0);
    assert.equal(await page.locator('.hub-navigation a[aria-current="page"]').count(), 1);
    await page.setViewportSize({ width: 320, height: 740 }); await noOverflow(page); await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.goto(`${base}/products`); await page.keyboard.press("Tab"); await page.getByRole("link", { name: "Skip to content" }).press("Enter");
  assert.equal(await page.locator("#hub-content").evaluate((el) => el === document.activeElement), true);
}));

test("fixture-only failure states distinguish missing dashboard, stale gates, unknown gates and unavailable registry", { timeout: 60_000 }, async () => browserTest(async (browser) => {
  const page = await browser.newPage({ viewport: { width: 320, height: 740 } });
  await page.route("**/api/modules/products", (route) => route.fulfill({ json: { generatedAt: "2026-11-20T00:00:00Z", registry: { state: "down", detail: "PJ registry unavailable or invalid." }, products: [
    { id: "no-receipt", name: "No receipt", stage: "launch", declaration: { commit: "a".repeat(40) }, launch: { state: "unknown", source: "launch dashboard receipt", nextStep: "Inspect launch evidence; readiness is unknown." }, issue: "Publication receipt unavailable." },
    { id: "stale", name: "Stale fixture", stage: "launch", declaration: { commit: "b".repeat(40) }, launch: { state: "stale", source: "launch dashboard receipt", observedAt: "2026-11-01T00:00:00Z", nextStep: "Recheck stale launch gates before relying on this dashboard." }, destination: { href: "https://s3.delo.sh/projects/fixture/2026-11-01/launch-dashboard/index.html", label: "Open launch dashboard", publishedAt: "2026-11-20T00:00:00Z" } }
  ], issues: [{ id: "fixture", name: "Private fixture", state: "invalid", detail: "Unknown mode." }] } }));
  await page.goto(`${base}/products`); await page.getByText("No successful PJ snapshot is available.", { exact: false }).waitFor();
  assert.equal(await page.getByText("No entries in the available snapshot; discovery is incomplete.").count(), 1);
  assert.equal(await page.locator('[data-product-id="no-receipt"] .product-unavailable').count(), 1);
  assert.match(await page.locator('[data-product-id="no-receipt"] .product-state').innerText(), /Readiness unknown/);
  assert.match(await page.locator('[data-product-id="stale"] .product-state').innerText(), /Stale evidence/);
  assert.equal(await page.locator('[data-product-id="stale"] .product-action').count(), 1);
  await noOverflow(page); await page.screenshot({ path: `${out}/fixture-unavailable-320.png`, fullPage: true });
  await page.unroute("**/api/modules/products"); await page.getByRole("button", { name: "Refresh sources" }).click(); await page.locator('[data-product-id="tolt"]').waitFor();
}));

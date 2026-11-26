import assert from "node:assert/strict";
import { test } from "node:test";

const playwright = process.env.PLAYWRIGHT_MODULE;
if (!playwright) throw Error("Set PLAYWRIGHT_MODULE to the installed Playwright index.mjs");
const { chromium } = await import(playwright);
const base = process.env.ARTIFACTS_TEST_URL ?? "http://127.0.0.1:19454";
const item = { id: "fixture:one", source: "projects", title: "private fixture only", filenames: ["fixture.jpg"], category: "images", originalUrl: "https://s3.delo.sh/projects/fixture/fixture.jpg", dateKind: "unknown" };
const catalog = (search, complete = true) => ({ items: search === "nomatch" ? [] : [item], total: search === "nomatch" ? 0 : 1, page: 1, limit: 24, retryAfterMs: 0, excludedUnknownDates: 0, complete, sources: { projects: { ok: complete, stale: false } } });

async function withPage(fn) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await fn(page);
  } finally { await browser.close(); }
}

test("manual refresh is consumed once; normal search and mode changes do not force reload", async () => withPage(async (page) => {
  const seen = [];
  await page.route("**/api/artifacts/catalog?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("featured") === "1") return route.fulfill({ json: catalog("nomatch") });
    seen.push(url.searchParams);
    await route.fulfill({ json: catalog(url.searchParams.get("search")) });
  });
  await page.goto(`${base}/artifacts`);
  await page.getByRole("heading", { name: item.title }).waitFor();
  await page.getByRole("button", { name: "Refresh sources" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("textbox", { name: "Search metadata" }).fill("private");
  await page.getByRole("heading", { name: item.title }).waitFor();
  await page.getByRole("textbox", { name: "Search metadata" }).fill("fixture");
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Picture gallery" }).click();
  await page.waitForTimeout(400);
  assert.equal(seen.length, 5);
  assert.deepEqual(seen.map((p) => p.get("refresh")), [null, "1", null, null, null]);
}));

test("late resolved response body cannot overwrite current filtered results", async () => withPage(async (page) => {
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.priorJsonStarted = false;
    window.fetch = async (...args) => {
      const response = await real(...args);
      if (String(args[0]).includes("/api/artifacts/catalog?") && new URL(String(args[0]), location.href).searchParams.get("search") === "private") {
        const body = await response.clone().json();
        return new Proxy(response, { get(target, prop) {
          if (prop === "json") return async () => { window.priorJsonStarted = true; return await new Promise((resolve) => { window.releasePriorJson = () => resolve(body); }); };
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      }
      return response;
    };
  });
  await page.route("**/api/artifacts/catalog?**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: catalog(url.searchParams.get("search")) });
  });
  await page.goto(`${base}/artifacts`);
  await page.getByRole("heading", { name: item.title }).waitFor();
  await page.getByRole("textbox", { name: "Search metadata" }).fill("private");
  await page.waitForFunction(() => window.priorJsonStarted);
  await page.getByRole("textbox", { name: "Search metadata" }).fill("nomatch");
  await page.getByText("No artifacts match these filters.").waitFor();
  await page.evaluate(() => window.releasePriorJson());
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole("heading", { name: item.title }).count(), 0);
  assert.equal(await page.getByText("No artifacts match these filters.").count(), 1);
}));

test("automatic recovery retries once and subsequent filter changes use cached catalog", async () => withPage(async (page) => {
  const seen = [];
  await page.route("**/api/artifacts/catalog?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("featured") === "1") return route.fulfill({ json: catalog("nomatch") });
    seen.push(url.searchParams);
    await route.fulfill({ json: catalog(url.searchParams.get("search"), seen.length !== 1) });
  });
  await page.goto(`${base}/artifacts`);
  await page.getByText("Retrying automatically while this page is open", { exact: false }).waitFor();
  await page.getByText("projects: available", { exact: false }).waitFor();
  await page.getByRole("textbox", { name: "Search metadata" }).fill("fixture");
  await page.waitForTimeout(400);
  assert.deepEqual(seen.map((p) => p.get("refresh")), [null, "1", null]);
}));

// ---- HOLOC-69 day navigator ----
const documents = await import(process.env.ARTIFACTS_DOCUMENTS_MODULE ?? new URL("../../../api/dist/artifact-documents.js", import.meta.url).href);
const folder = "https://s3.delo.sh/projects/demo/2026-11-25/report/";
const dayItem = (id, title, over = {}) => ({ id, source: "projects", project: "demo", title, filenames: [id.split("/").at(-1)], category: "other", originalUrl: `${folder}${id.split("/").at(-1)}`, dateKind: "modified", date: "2026-11-25T15:00:00Z",
  collection: "demo", day: "2026-11-25", dayKind: "published", layout: "dated", publication: "projects:demo/2026-11-25/report", primary: false, baseUrl: folder, ...over });
const day25 = [
  dayItem("projects:demo/2026-11-25/report/index.html", "Report bundle", { primary: true, filenames: ["assets/style.css", "hostile.md", "index.html"] }),
  dayItem("projects:demo/2026-11-25/report/hostile.md", "hostile.md"),
  dayItem("projects:demo/2026-11-25/report/chart.png", "chart.png", { category: "images", mediaUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==" })
];
const day26 = [dayItem("projects:demo/2026-11-26/next/index.html", "Next day page", { day: "2026-11-26", publication: "projects:demo/2026-11-26/next", primary: true, baseUrl: "https://s3.delo.sh/projects/demo/2026-11-26/next/", originalUrl: "https://s3.delo.sh/projects/demo/2026-11-26/next/index.html" })];
const dayResponse = (day) => ({ items: day === "2026-11-26" ? day26 : day25, total: (day === "2026-11-26" ? day26 : day25).length, page: 1, limit: 1000, excludedUnknownDates: 0, retryAfterMs: 0, complete: true, sources: { projects: { ok: true, stale: false } },
  navigation: day === "2026-11-26" ? { collection: "demo", day, dayKinds: ["published"], count: 1, previous: { day: "2026-11-25", count: 3 } } : { collection: "demo", day, dayKinds: ["published"], count: 3, next: { day: "2026-11-26", count: 1 }, hubUrl: "https://s3.delo.sh/projects/demo/2026-11-25/index-0123456789ab.html" } });
const hostileHtml = (api) => `<!doctype html><html><head><title>hostile</title></head><body><h1 id="top">hostile</h1><a id="jump" href="#end">jump</a><div style="height:2000px"></div><p id="end">end</p><pre id="out"></pre><script>
var r={};function t(k,f){try{r[k]="ALLOWED:"+String(f()).slice(0,60)}catch(e){r[k]="blocked:"+(e&&e.name)}}
t("origin",function(){return self.origin});t("parentDocument",function(){return parent.document.title});t("parentSecret",function(){return parent.__holoceneSecret});
t("topHref",function(){return top.location.href});t("cookie",function(){return document.cookie});t("localStorage",function(){return localStorage.length});
t("topNavigate",function(){top.location.href="about:blank#escaped";return "assigned"});
(async function(){for(const [k,u] of [["fetchApi",${JSON.stringify(api)}],["fetchRelative","/api/artifacts/catalog?limit=1"]]){try{const res=await fetch(u,{credentials:"include"});r[k]="ALLOWED:"+res.status}catch(e){r[k]="blocked:"+(e&&e.name)}}
document.body.setAttribute("data-probes",JSON.stringify(r))})();</script></body></html>`;
const hostileMd = "# Hostile\n\n<script>parent.document.title='owned'</script>\n\n<img src=x onerror=\"parent.document.title='owned'\">\n\n[js](javascript:alert(1)) [rel](./index.html)\n";

async function routeDay(page, seen = []) {
  await page.route("**/api/artifacts/catalog?**", async (route) => {
    const url = new URL(route.request().url());
    seen.push(url.searchParams);
    if (url.searchParams.get("day")) return route.fulfill({ json: dayResponse(url.searchParams.get("day")) });
    return route.fulfill({ json: { ...catalog(url.searchParams.get("search")), items: url.searchParams.get("featured") ? [] : [day25[0]] } });
  });
  await page.route("**/api/artifacts/document?**", async (route) => {
    const url = new URL(route.request().url());
    const md = url.searchParams.get("id").endsWith(".md") || url.searchParams.get("file") === "hostile.md";
    const srcdoc = md ? documents.renderMarkdown(hostileMd, folder, "hostile.md") : documents.wrapHtml(hostileHtml(`${base}/api/artifacts/catalog?limit=1`), folder);
    await route.fulfill({ json: { kind: md ? "markdown" : "html", srcdoc, sourceUrl: folder, baseUrl: folder, truncated: false } });
  });
}

test("deep link opens the day navigator; artifact and day navigation follow the URL; close returns to the gallery", async () => withPage(async (page) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await routeDay(page);
  await page.goto(`${base}/artifacts?project=demo&day=2026-11-25&artifact=${encodeURIComponent(day25[1].id)}`);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Wed, Nov 25, 2026" }).waitFor();
  assert.equal(await dialog.locator('[aria-current="true"]').innerText().then((t) => t.includes("hostile.md")), true);
  await dialog.getByRole("button", { name: "Next →" }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get("artifact")?.endsWith("chart.png"));
  assert.equal(await dialog.getByRole("button", { name: "Next →" }).isDisabled(), true);
  assert.equal(await dialog.getByRole("link", { name: "Published day index ↗" }).count(), 1);
  await dialog.getByRole("button", { name: /^Next day/ }).click();
  await dialog.getByRole("heading", { name: "Thu, Nov 26, 2026" }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("day"), "2026-11-26");
  await dialog.getByRole("button", { name: /^Previous day/ }).click();
  await dialog.getByRole("heading", { name: "Wed, Nov 25, 2026" }).waitFor();
  const download = await dialog.getByRole("link", { name: "Download" }).first().getAttribute("href");
  assert.ok(download.startsWith("/api/artifacts/download?id=projects%3Ademo"));
  await dialog.getByRole("button", { name: "← Gallery" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(new URL(page.url()).search, "");
  assert.deepEqual(errors, []);
}));

test("View day on a search result opens its project/day; Back closes the navigator", async () => withPage(async (page) => {
  await routeDay(page);
  await page.goto(`${base}/artifacts`);
  await page.getByRole("button", { name: "View day: Report bundle" }).click();
  await page.getByRole("dialog").getByRole("heading", { name: "Wed, Nov 25, 2026" }).waitFor();
  const params = new URL(page.url()).searchParams;
  assert.deepEqual([params.get("project"), params.get("day"), params.get("artifact")], ["demo", "2026-11-25", day25[0].id]);
  await page.goBack();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "By day" }).waitFor();
}));

test("hostile HTML and Markdown render isolated from Holocene's DOM, cookies, storage, API and top navigation", async () => withPage(async (page) => {
  const leaks = [];
  page.on("request", (req) => { if (req.frame() !== page.mainFrame() && /\/api\//.test(req.url())) leaks.push(req.url()); });
  await page.addInitScript(() => { window.__holoceneSecret = "s3cret"; document.cookie = "holocene_probe=1; path=/"; });
  await routeDay(page);
  await page.goto(`${base}/artifacts?project=demo&day=2026-11-25&artifact=${encodeURIComponent(day25[0].id)}`);
  const frameEl = page.locator("iframe[data-kind=html]");
  await frameEl.waitFor();
  assert.equal(await frameEl.getAttribute("sandbox"), "allow-scripts allow-popups allow-popups-to-escape-sandbox");
  const frame = await frameEl.elementHandle().then((h) => h.contentFrame());
  await frame.waitForSelector("body[data-probes]");
  const probes = JSON.parse(await frame.locator("body").getAttribute("data-probes"));
  assert.equal(probes.origin, "ALLOWED:null", "opaque origin");
  for (const [key, value] of Object.entries(probes)) if (key !== "origin") assert.match(value, /^blocked:/, `${key}: ${value}`);
  await frame.locator("#jump").click();
  assert.equal(page.frames().includes(frame) && await frame.evaluate(() => location.href), "about:srcdoc", "fragment link stays in the srcdoc");
  assert.equal(new URL(page.url()).pathname, "/artifacts");
  assert.equal(await page.evaluate(() => window.__holoceneSecret), "s3cret");
  await page.getByRole("dialog").getByRole("button", { name: "Next →" }).click();
  const md = page.locator("iframe[data-kind=markdown]");
  await md.waitFor();
  assert.equal(await md.getAttribute("sandbox"), "allow-popups allow-popups-to-escape-sandbox");
  const mdFrame = await md.elementHandle().then((h) => h.contentFrame());
  await mdFrame.locator("h1").waitFor();
  assert.equal(await mdFrame.locator("script, img[src=x], a[href^=javascript]").count(), 0);
  assert.equal(await mdFrame.locator(`a[href="${folder}index.html"]`).count(), 1);
  assert.notEqual(await page.title(), "owned");
  assert.deepEqual(leaks, []);
}));

test("phone width keeps the navigator inside the viewport", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await routeDay(page);
    await page.goto(`${base}/artifacts?project=demo&day=2026-11-25&artifact=${encodeURIComponent(day25[2].id)}`);
    await page.getByRole("dialog").getByRole("heading", { name: "Wed, Nov 25, 2026" }).waitFor();
    const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.querySelector(".artifact-nav").scrollWidth, innerWidth]);
    assert.deepEqual(widths, [390, 390, 390]);
  } finally { await browser.close(); }
});

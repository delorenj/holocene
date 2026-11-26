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

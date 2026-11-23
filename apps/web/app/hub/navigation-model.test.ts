import assert from "node:assert/strict";
import { test } from "node:test";
import { currentGroup, nativeModifiedClick, NAV_GROUPS, PRODUCT_LINKS, PROJECT_LINKS, projectsAncestor, productStage } from "./navigation-model";
test("shared hierarchy retains old routes with one Projects parent and exact child wording", () => {
  const links = [...PRODUCT_LINKS, ...PROJECT_LINKS, ...NAV_GROUPS.flatMap((g) => g.items)];
  for (const href of ["/products", "/products?stage=launch", "/products?stage=live", "/live", "/?view=agents", "/?view=projects", "/genesis", "/voice", "/wax", "/transcripts", "/artifacts", "/candybar", "/settings", "/mini", "/hooks", "/legacy"]) assert.ok(links.some((l) => l.href === href), href);
  assert.deepEqual(PROJECT_LINKS.map((x) => x.label), ["Live products", "Launch mode products", "All projects"]);
  assert.equal(links.filter((x) => x.label === "Projects").length, 0);
  assert.equal(PRODUCT_LINKS[0].label, "Products");
  assert.equal(projectsAncestor("projects"), true); assert.equal(projectsAncestor("products-launch"), true);
  assert.equal(new Set(links.map((l) => l.id)).size, links.length);
  assert.equal(currentGroup("live"), "workspace"); assert.equal(currentGroup("wax"), "media");
  assert.equal(productStage("?stage=live&focus=earshot"), "live"); assert.equal(productStage("?stage=unknown"), undefined);
});
test("only an unmodified left click is interceptable, hrefs preserve native navigation", () => {
  const click = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 };
  assert.equal(nativeModifiedClick(click), false);
  for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) assert.equal(nativeModifiedClick({ ...click, [key]: true }), true);
  assert.equal(nativeModifiedClick({ ...click, button: 1 }), true);
});

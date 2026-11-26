import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactPolicy, documentKind, markdownToHtml, renderMarkdown, safeMarkdownUrl, wrapHtml, wrapText } from "./artifact-documents.js";

const BASE = "https://s3.delo.sh/projects/demo/2026-11-20/site/";

test("document kinds come from the extension, then a text-like content type", () => {
  assert.equal(documentKind("index.html"), "html");
  assert.equal(documentKind("dir/README.MD"), "markdown");
  for (const name of ["run.log", "data.json", "rows.jsonl", "a.diff", "script.py"]) assert.equal(documentKind(name), "text", name);
  assert.equal(documentKind("job.exit", "text/plain; charset=utf-8"), "text");
  assert.equal(documentKind("feed", "application/ld+json"), "text");
  assert.equal(documentKind("bundle.zip", "application/zip"), undefined);
  assert.equal(documentKind("secret.gpg", "application/octet-stream"), undefined);
});

test("the artifact policy blocks network, frames, forms and base changes; scripts only for HTML", () => {
  const html = artifactPolicy(BASE, true);
  for (const part of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(html.includes(part), part);
  assert.match(html, new RegExp(`script-src 'unsafe-inline' 'unsafe-eval' ${BASE.replace(/[.\/]/g, "\\$&")} https://cdnjs`));
  assert.ok(!html.includes("script-src *") && !/script-src[^;]*https:(?!\/\/)/.test(html), "no blanket script hosts");
  assert.match(artifactPolicy(BASE, false), /script-src 'none'/);
});

test("wrapHtml puts base + CSP before any artifact markup and keeps the doctype first", () => {
  const out = wrapHtml("﻿<!-- note --><!DOCTYPE html><html lang=en><head><script>x()</script>", BASE);
  assert.ok(out.startsWith("<!DOCTYPE html><base href=\"" + BASE + "\" target=\"_blank\"><meta http-equiv=\"Content-Security-Policy\""));
  assert.ok(out.indexOf("Content-Security-Policy") < out.indexOf("x()"));
  assert.ok(out.includes("<!-- note --><html lang=en>"), "leading comment kept after the injected head");
  const bare = wrapHtml("<p>no doctype</p><script>top.location='x'</script>", BASE);
  assert.ok(bare.startsWith("<base href="));
  assert.ok(bare.includes('<meta name="referrer" content="no-referrer">'));
});

test("hostile Markdown is inert text: no raw HTML, no script, no javascript: links", () => {
  const md = [
    "# Title <script>alert(1)</script>",
    "<script>parent.document.body.innerHTML='owned'</script>",
    "<img src=x onerror=\"parent.document.title='owned'\">",
    "[click](javascript:alert(1)) [data](data:text/html,<script>alert(1)</script>) [vb](VBScript:msgbox)",
    "![pixel](javascript:alert(1))",
    "<iframe src=\"https://holocene.delo.sh\"></iframe>"
  ].join("\n\n");
  const html = markdownToHtml(md, BASE);
  assert.doesNotMatch(html, /<script|<img src="x"|<iframe|onerror="|href="javascript|href="data|src="javascript|href="vbscript/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<h1 id="title-scriptalert1script">Title &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
  const doc = renderMarkdown(md, BASE, "x.md");
  assert.match(doc, /script-src 'none'/);
  assert.doesNotMatch(doc, /<base /, "markdown resolves its own URLs; fragments stay in the srcdoc");
});

test("Markdown renders the common report vocabulary with resolved relative links", () => {
  const md = [
    "## Summary", "", "Some **bold**, *em*, `code <b>`, ~~gone~~ and snake_case_name.", "",
    "- one", "- [x] done", "  - nested", "", "1. first", "2. second", "",
    "> quoted **text**", "", "| a | b |", "|:--|--:|", "| 1 | [rel](./other.md) |", "",
    "```ts", "const x = '<tag>';", "```", "", "---", "", "See https://example.com/path. And [top](#summary).", "", "![shot](assets/shot.png \"Shot\")"
  ].join("\n");
  const html = markdownToHtml(md, BASE);
  assert.match(html, /<h2 id="summary">Summary<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>, <em>em<\/em>, <code>code &lt;b&gt;<\/code>, <del>gone<\/del> and snake_case_name\./);
  assert.match(html, /<ul><li>one<\/li><li><input type="checkbox" disabled checked>done\n<ul><li>nested<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quoted <strong>text<\/strong><\/p><\/blockquote>/);
  assert.match(html, /<th style="text-align:left">a<\/th><th style="text-align:right">b<\/th>/);
  assert.ok(html.includes(`<a href="${BASE}other.md" target="_blank" rel="noopener noreferrer">rel</a>`));
  assert.match(html, /<pre><code class="language-ts">const x = &#39;&lt;tag&gt;&#39;;<\/code><\/pre>/);
  assert.match(html, /<hr>/);
  assert.ok(html.includes('<a href="https://example.com/path" target="_blank" rel="noopener noreferrer">https://example.com/path</a>.'));
  assert.ok(html.includes('<a href="#summary">top</a>'));
  assert.ok(html.includes(`<img src="${BASE}assets/shot.png" alt="shot" title="Shot" loading="lazy">`));
});

test("safe URLs: http(s), mailto, fragments and relative only", () => {
  assert.equal(safeMarkdownUrl("../up.md", BASE)?.href, "https://s3.delo.sh/projects/demo/2026-11-20/up.md");
  assert.equal(safeMarkdownUrl("mailto:a@b.c", BASE)?.href, "mailto:a@b.c");
  assert.equal(safeMarkdownUrl("mailto:a@b.c", BASE, true), undefined);
  for (const bad of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,x", "file:///etc/passwd", "java\nscript:alert(1)"]) assert.equal(safeMarkdownUrl(bad, BASE), undefined, bad);
});

test("text documents are escaped, JSON is pretty-printed and truncation is labelled", () => {
  const doc = wrapText('{"a":"<script>"}', BASE, "data.json", true);
  assert.ok(doc.includes("{\n  &quot;a&quot;: &quot;&lt;script&gt;&quot;\n}"));
  assert.match(doc, /Showing the first 1024 KB/);
  assert.match(doc, /script-src 'none'/);
});

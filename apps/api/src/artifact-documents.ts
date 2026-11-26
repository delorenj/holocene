// Inline rendering for catalog artifacts (HOLOC-69). Everything here builds a complete
// `srcdoc` document that the web app mounts in a sandboxed iframe WITHOUT allow-same-origin,
// so the document has an opaque origin: no Holocene cookies, storage, DOM or API. The CSP
// meta below is the second wall; it is the first element the parser sees.

export type DocumentKind = "html" | "markdown" | "text";

/** CDNs the artifact-design contract lets published pages load scripts from. */
export const SCRIPT_CDNS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdn.tailwindcss.com", "https://code.jquery.com"];
export const HTML_LIMIT = 4 * 1024 * 1024;
export const TEXT_LIMIT = 1024 * 1024;

const TEXT_TYPE = /^(?:text\/|application\/(?:json|x-ndjson|jsonl|xml|javascript|x-yaml|yaml|toml|x-sh)|[^;]*\+(?:json|xml))/i;
export function documentKind(name: string, contentType = ""): DocumentKind | undefined {
  const ext = name.split("/").at(-1)!.split(".").pop()?.toLowerCase() ?? "";
  if (/^(?:html?|xhtml)$/.test(ext)) return "html";
  if (/^(?:md|markdown|mdown|mkd)$/.test(ext)) return "markdown";
  if (/^(?:txt|log|json|jsonl|ndjson|csv|tsv|ya?ml|toml|ini|cfg|conf|xml|py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|diff|patch|sql|rs|go|rb|java|c|h|cpp|css|mmd|dsl|srt|vtt|out|err)$/.test(ext)) return "text";
  return TEXT_TYPE.test(contentType.trim()) ? "text" : undefined;
}

/** For double-quoted attribute values we write ourselves (CSP source lists keep their quotes). */
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The CSP every rendered artifact runs under. `scripts` is true only for HTML artifacts. */
export function artifactPolicy(baseUrl: string, scripts: boolean): string {
  return [
    "default-src 'none'",
    scripts ? `script-src 'unsafe-inline' 'unsafe-eval' ${baseUrl} ${SCRIPT_CDNS.join(" ")}` : "script-src 'none'",
    "style-src 'unsafe-inline' https:",
    "img-src https: data: blob:",
    "font-src https: data:",
    "media-src https: data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
  ].join("; ");
}

// HTML keeps its relative links working through <base>; Markdown/text resolve URLs themselves
// (no <base>) so `#fragment` links stay inside the about:srcdoc document.
const head = (baseUrl: string, scripts: boolean, base: boolean) =>
  (base ? `<base href="${escapeAttr(baseUrl)}" target="_blank">` : "")
  + `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(artifactPolicy(baseUrl, scripts))}">`
  + `<meta name="referrer" content="no-referrer">`;

// With <base> pointing at the original folder, `#section` would resolve to the S3 URL and open
// a new tab; keep in-page anchors in place. This is Holocene's own script inside the sandbox.
const FRAGMENTS = `<script>document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href^='#']"):null;if(!a)return;e.preventDefault();var id=decodeURIComponent(a.getAttribute("href").slice(1));var t=id?(document.getElementById(id)||document.getElementsByName(id)[0]):null;if(t)t.scrollIntoView();else if(!id)scrollTo(0,0)},true)</script>`;

/** Prefix an HTML artifact with base + CSP, keeping any leading doctype first (standards mode). */
export function wrapHtml(html: string, baseUrl: string): string {
  const lead = html.match(/^﻿?(?:\s|<!--[\s\S]*?-->)*(<!doctype[^>]*>)?/i)!;
  const doctype = lead[1] ?? "";
  const before = doctype ? lead[0].slice(0, lead[0].length - doctype.length).replace(/^﻿/, "") : "";
  const rest = html.slice(doctype ? lead[0].length : 0).replace(/^﻿/, "");
  return `${doctype}${head(baseUrl, true, true)}${FRAGMENTS}${before}${rest}`;
}

const SHELL_CSS = `:root{color-scheme:light dark;--fg:#1d1c1a;--mute:#6b6861;--line:#dedbd3;--bg:#fbfaf7;--code:#f0eee8;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--fg:#ecebe6;--mute:#9c988f;--line:#34322d;--bg:#151412;--code:#1f1e1b;--accent:#fb923c}}
html{background:var(--bg);color:var(--fg)}body{margin:0;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 20px 64px;overflow-wrap:anywhere}
a{color:var(--accent)}h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.6em 0 .5em}h1{font-size:1.9em}h2{font-size:1.45em;border-bottom:1px solid var(--line);padding-bottom:.2em}
pre,code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code)}code{padding:.1em .3em;border-radius:3px}
pre{padding:12px 14px;overflow:auto;border:1px solid var(--line);white-space:pre}pre code{padding:0;background:none}
pre.text{white-space:pre-wrap;word-break:break-word;margin:0;border:0;background:none;padding:16px}
blockquote{margin:1em 0;padding:0 1em;border-left:4px solid var(--line);color:var(--mute)}
table{border-collapse:collapse;display:block;overflow:auto;max-width:100%}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
img{max-width:100%}hr{border:0;border-top:1px solid var(--line);margin:2em 0}.notice{color:var(--mute);font-size:13px;border:1px dashed var(--line);padding:8px 12px}
li>input[type=checkbox]{margin-right:.4em}`;

const shell = (baseUrl: string, title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8">${head(baseUrl, false, false)}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${SHELL_CSS}</style></head><body>${body}</body></html>`;

export function wrapText(text: string, baseUrl: string, name: string, truncated = false): string {
  let body = text;
  if (/\.json$/i.test(name)) { try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* show as published */ } }
  const notice = truncated ? `<p class="notice">Showing the first ${Math.round(TEXT_LIMIT / 1024)} KB. Download or open the original for the full file.</p>` : "";
  return shell(baseUrl, name, `${notice}<pre class="text">${escapeHtml(body)}</pre>`);
}

// ---- Markdown: escape first, then add only the elements this renderer emits itself. ----

type SafeUrl = { href: string; external: boolean };
export function safeMarkdownUrl(raw: string, baseUrl: string, image = false): SafeUrl | undefined {
  const value = raw.trim().replace(/^<|>$/g, "");
  if (!value || /[\u0000-\u001f\s]/.test(value)) return;
  if (value.startsWith("#")) return image ? undefined : { href: value, external: false };
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol === "https:" || url.protocol === "http:") return { href: url.href, external: true };
    if (!image && url.protocol === "mailto:") return { href: url.href, external: true };
  } catch { /* not a URL */ }
  return;
}

const slug = (text: string) => text.toLowerCase().replace(/<[^>]*>/g, "").replace(/&[a-z0-9#]+;/gi, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");

function inline(src: string, baseUrl: string): string {
  const slots: string[] = [];
  const keep = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src.replace(/\u0000/g, "");
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code: string) => keep(`<code>${escapeHtml(code.trim())}</code>`));
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|~<>])/g, (_m, ch: string) => keep(escapeHtml(ch)));
  // Link parts never span a "[", so each attempt stops at the next bracket: linear on "[[[[…" runs.
  s = s.replace(/!\[([^[\]]*)\]\(\s*(<[^<>[\]\n]*>|[^)\s[\]]+)(?:\s+"([^"[\]\n]*)")?\s*\)/g, (m, alt: string, url: string, title?: string) => {
    const safe = safeMarkdownUrl(url, baseUrl, true);
    return keep(safe ? `<img src="${escapeHtml(safe.href)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ""} loading="lazy">` : escapeHtml(m));
  });
  s = s.replace(/\[([^[\]]+)\]\(\s*(<[^<>[\]\n]*>|[^)\s[\]]+)(?:\s+"([^"[\]\n]*)")?\s*\)/g, (_m, text: string, url: string) => {
    const safe = safeMarkdownUrl(url, baseUrl);
    if (!safe) return text;
    return keep(`<a href="${escapeHtml(safe.href)}"${safe.external ? ' target="_blank" rel="noopener noreferrer"' : ""}>`) + text + keep("</a>");
  });
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/g, (m, url: string) => {
    const safe = safeMarkdownUrl(url, baseUrl);
    return safe ? keep(`<a href="${escapeHtml(safe.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`) : m;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>\u0000]*[^\s<>\u0000.,:;"')\]!?])/g, (_m, lead: string, url: string) => {
    const safe = safeMarkdownUrl(url, baseUrl);
    return lead + (safe ? keep(`<a href="${escapeHtml(safe.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`) : url);
  });
  s = escapeHtml(s);
  // A span never crosses its own next delimiter, so an unclosed run stops there: linear on "**a **a …".
  s = s.replace(/(\*\*|__)(?=\S)((?:(?!\1)[\s\S])*?\S)\1/g, "<strong>$2</strong>")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?![\w])/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)((?:(?!~~)[\s\S])*?\S)~~/g, "<del>$1</del>")
    .replace(/(?: {2,}|\\)\n/g, "<br>\n");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)]);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
// Strip blanks, then match single-character runs: a grouped `(?:\*\s*){3,}` overflows V8's stack on a multi-MB line.
const RULE = { test: (line: string) => /^ {0,3}[-*_]/.test(line) && /^(?:\*{3,}|-{3,}|_{3,})$/.test(line.replace(/\s+/g, "")) };
const ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
const isTableStart = (lines: string[], i: number) => lines[i].includes("|") && lines[i + 1] !== undefined && lines[i + 1].includes("-")
  && TABLE_DELIM.test(lines[i + 1]) && cells(lines[i + 1]).length === cells(lines[i]).length;
const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || ITEM.test(line) || QUOTE.test(line);

function blocks(lines: string[], baseUrl: string, ids: Map<string, number>, depth = 0): string {
  if (depth > 12) return `<p>${escapeHtml(lines.join("\n"))}</p>`;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      const lang = fence[2].replace(/[^\w+-]/g, "");
      out.push(`<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      const html = inline(heading[2] ?? "", baseUrl);
      const base = slug(html) || "section";
      const n = ids.get(base) ?? 0;
      ids.set(base, n + 1);
      out.push(`<h${level} id="${escapeHtml(n ? `${base}-${n}` : base)}">${html}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) { out.push("<hr>"); i++; continue; }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i]))) body.push(lines[i++].replace(QUOTE, "$1"));
      out.push(`<blockquote>${blocks(body, baseUrl, ids, depth + 1)}</blockquote>`);
      continue;
    }
    const item = line.match(ITEM);
    if (item) {
      const indent = item[1].length;
      const ordered = /\d/.test(item[2]);
      const entries: string[][] = [];
      while (i < lines.length) {
        const current = lines[i];
        const m = current.match(ITEM);
        if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) { entries.push([m[3]]); i++; continue; }
        if (!current.trim()) {
          const next = lines[i + 1];
          if (next !== undefined && (next.match(/^ */)![0].length > indent)) { entries.at(-1)!.push(""); i++; continue; }
          break;
        }
        if (current.match(/^ */)![0].length > indent || (!startsBlock(current) && !m)) { entries.at(-1)!.push(current.replace(new RegExp(`^ {0,${indent + 4}}`), "")); i++; continue; }
        break;
      }
      const start = ordered ? Number(item[2].replace(/\D/g, "")) : 1;
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${entries.map((entry) => {
        const task = entry[0].match(/^\[([ xX])\]\s+(.*)$/);
        if (task) entry[0] = task[2];
        const rendered = blocks(entry, baseUrl, ids, depth + 1);
        const tight = !entry.includes("") ? rendered.replace(/^<p>([\s\S]*?)<\/p>/, "$1") : rendered;
        return `<li>${task ? `<input type="checkbox" disabled${task[1] !== " " ? " checked" : ""}>` : ""}${tight}</li>`;
      }).join("")}</${tag}>`);
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "");
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
      const cell = (tag: string, text: string, k: number) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(text, baseUrl)}</${tag}>`;
      out.push(`<table><thead><tr>${header.map((h, k) => cell("th", h, k)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${header.map((_h, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && (!para.length || !startsBlock(lines[i])) && !(para.length && isTableStart(lines, i))) para.push(lines[i++]);
    out.push(`<p>${inline(para.join("\n"), baseUrl)}</p>`);
  }
  return out.join("\n");
}

/** Escape-first Markdown: raw HTML in the source is text, links are http(s)/mailto/relative/#only. */
export function markdownToHtml(markdown: string, baseUrl: string): string {
  const lines = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return blocks(lines, baseUrl, new Map());
}

export function renderMarkdown(markdown: string, baseUrl: string, name: string): string {
  return shell(baseUrl, name, `<main>${markdownToHtml(markdown, baseUrl)}</main>`);
}

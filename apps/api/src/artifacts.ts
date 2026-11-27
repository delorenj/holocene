import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { decodeHTML, decodeHTMLAttribute } from "entities";
import { HTML_LIMIT, TEXT_LIMIT, documentKind, renderMarkdown, wrapHtml, wrapText } from "./artifact-documents.js";

const exec = promisify(execFile);
export type Category = "images" | "videos" | "audio" | "pdfs" | "other";
export type DateKind = "published" | "modified" | "unknown";
// Placement (HOLOC-69): where an artifact lives as Collection → Day → Publication. Computed once
// during normalization so gallery search, day groups, the navigator and deep links share it.
export type Placement = { collection?: string; day?: string; dayKind?: DateKind; layout?: "dated" | "session" | "share" | "video"; publication?: string; primary?: boolean; baseUrl?: string; hubUrl?: string };
export type Artifact = { id: string; source: "projects" | "share" | "r2"; project?: string; title: string; description?: string; filenames: string[]; category: Category; originalUrl: string; mediaUrl?: string; posterUrl?: string; date?: string; dateKind: DateKind; gallery?: string; galleryUrl?: string; variant?: string } & Placement;
type ObjectRow = { key: string; modified?: string; size?: number };
type Enrichment = Record<string, { title?: string; description?: string; published?: string; enrichmentFailed?: boolean; manifest?: unknown }>;
export type SourceResult = { items: Artifact[]; ok: boolean; fetchedAt?: string; stale: boolean };
const BASE = "https://s3.delo.sh";
const VIDEO = "https://v.delo.sh";
const MEDIA: Record<string, Category> = { jpg: "images", jpeg: "images", png: "images", gif: "images", webp: "images", avif: "images", svg: "images", mp4: "videos", mov: "videos", webm: "videos", m4v: "videos", mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", flac: "audio", pdf: "pdfs" };
const SCAFFOLD = /^(?:index(?:-[0-9a-f]{12,64})?\.html?|gallery\.json|gallery\.html|favicon\..*|package\.json|.*\.(?:css|js|mjs|map|woff2?|ttf|ico|vtt|srt))$/i;
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");
const safeKey = (key: string) => !key.split("/").some((part) => !part || part === "." || part === ".." || /[\x00-\x1f\\]/.test(part));
export function safePublishedUrl(value: unknown, origin: string): string | undefined {
  if (typeof value !== "string") return;
  try {
    if (/%2e|%2f|%5c|(^|\/)\.\.?($|\/)/i.test(value)) return;
    const url = new URL(value);
    if (url.origin !== origin || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !safeKey(decodeURIComponent(url.pathname.slice(1)))) return;
    return url.href;
  } catch { return; }
}
const category = (name: string): Category => MEDIA[name.split(".").pop()?.toLowerCase() ?? ""] ?? "other";
const validDate = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const label = (name: string) => name.replace(/[-_]+/g, " ");
/** Days are America/New_York calendar days: the zone publish.py names dated folders in. */
export const CATALOG_ZONE = "America/New_York";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (value: string) => DAY.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const dayFormat = new Map<string, Intl.DateTimeFormat>();
export function localDay(instant: string | undefined, zone = CATALOG_ZONE): string | undefined {
  if (!instant || !Number.isFinite(Date.parse(instant))) return;
  const dtf = dayFormat.get(zone) ?? new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  dayFormat.set(zone, dtf);
  const parts = Object.fromEntries(dtf.formatToParts(Date.parse(instant)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const HUB = /^index-[0-9a-f]{12,64}\.html$/i;

// Publish.py chooses index.html, then the only HTML, then the first file. A site is one
// publication; independently usable media/docs inside it retain their own original links.
export function normalizeMinio(bucket: "projects" | "share", rows: ObjectRow[]): Artifact[] {
  const groups = new Map<string, { project?: string; name: string; files: ObjectRow[] }>();
  // Published day hubs are navigation for their day, never artifacts of their own.
  const hubs = new Map<string, string>();
  for (const row of rows) {
    const parts = row.key.split("/");
    if (bucket === "projects" && safeKey(row.key) && parts.length === 3 && isDay(parts[1]) && HUB.test(parts[2])) hubs.set(`${parts[0]}/${parts[1]}`, `${BASE}/${bucket}/${encodeKey(row.key)}`);
    if (!safeKey(row.key) || parts.length < 3) continue;
    if (parts.some((p) => HUB.test(p))) continue;
    // Older session folders sometimes have loose files rather than an artifact subfolder.
    const prefix = bucket === "projects" ? parts.slice(0, parts.length === 3 ? 2 : 3) : parts.slice(0, 2);
    const id = prefix.join("/");
    const group = groups.get(id) ?? { project: bucket === "projects" ? parts[0] : undefined, name: prefix.at(-1)!, files: [] };
    group.files.push(row);
    groups.set(id, group);
  }
  const out: Artifact[] = [];
  for (const [prefix, group] of groups) {
    // HOLOC-70 review revisions are hash-addressed copies, listed by the project home, not the gallery.
    if (bucket === "projects" && /^review-[a-f0-9]{16}$/.test(group.name) && isDay(prefix.split("/")[1] ?? "")) continue;
    const files = group.files.sort((a, b) => a.key.localeCompare(b.key));
    const rel = (row: ObjectRow) => row.key.slice(prefix.length + 1);
    const html = files.find((r) => /^index\.html?$/i.test(rel(r))) ?? files.find((r) => /\.html?$/i.test(rel(r)));
    const useful = files.filter((r) => !SCAFFOLD.test(rel(r).split("/").at(-1)!) && (!/^(?:assets|static|_next)\//.test(rel(r)) || category(rel(r)) !== "other"));
    const primary = html ?? useful[0];
    if (!primary) continue;
    // Only identified publication bundles collapse extra HTML into one site. A legacy
    // session folder with a root index is a site; without one its pages stand alone.
    const loose = bucket === "projects" && prefix.split("/").length === 2 && !files.some((r) => /^index\.html?$/i.test(rel(r)));
    const originals = useful.filter((r) => loose || r === primary || !/\.html?$/i.test(rel(r)));
    const newest = validDate(files.map((r) => r.modified).filter(Boolean).sort().at(-1));
    const segments = prefix.split("/");
    const dated = bucket === "projects" && isDay(segments[1]);
    const make = (file: ObjectRow, isPrimary: boolean): Artifact => {
      const filename = rel(file);
      const url = `${BASE}/${bucket}/${encodeKey(file.key)}`;
      const kind = category(filename);
      const date = validDate(file.modified) ?? newest;
      // A dated folder is the publication day publish.py chose; a modified time is only that.
      // An undated bundle takes its newest file's day for every member, so it never splits.
      const day = dated ? segments[1] : localDay(loose ? date : newest);
      return { id: `${bucket}:${file.key}`, source: bucket, project: group.project,
        title: isPrimary && !loose ? label(group.name) : label(filename.split("/").at(-1)!),
        filenames: isPrimary && !loose ? files.map(rel) : [filename], category: kind,
        originalUrl: url, mediaUrl: kind !== "other" ? url : undefined,
        date, dateKind: date ? "modified" : "unknown",
        collection: bucket === "projects" ? projectCollection(group.project!) : "share", day, dayKind: dated ? "published" : day ? "modified" : "unknown",
        layout: bucket === "share" ? "share" : dated ? "dated" : "session",
        publication: loose ? `${bucket}:${file.key}` : `${bucket}:${prefix}`, primary: isPrimary || loose,
        baseUrl: `${BASE}/${bucket}/${encodeKey(prefix)}/`, hubUrl: dated ? hubs.get(`${segments[0]}/${segments[1]}`) : undefined };
    };
    out.push(make(primary, true));
    for (const file of originals) if (file !== primary) out.push(make(file, false));
  }
  return out;
}

export function normalizeR2(rows: ObjectRow[], enrichment: Enrichment = {}): Artifact[] {
  const groups = new Map<string, ObjectRow[]>();
  for (const row of rows) {
    if (!safeKey(row.key)) continue;
    const parts = row.key.split("/");
    if (parts.length !== 2 || !/^[a-f0-9]{16,64}$/.test(parts[0])) continue;
    groups.set(parts[0], [...(groups.get(parts[0]) ?? []), row]);
  }
  const byId = new Map<string, Artifact>();
  // Build member pages first so a gallery variant can inherit their published
  // timestamp, description, poster and playable filename before adding labels.
  for (const [token, files] of groups) {
    const page = files.find((r) => !r.key.split("/")[1].includes("."));
    if (!page) continue;
    const name = page.key.split("/")[1];
    const rawTitle = enrichment[page.key]?.title;
    const title = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.slice(0, 300) : label(name);
    const published = validDate(enrichment[page.key]?.published);
    const rawDescription = enrichment[page.key]?.description;
    const description = typeof rawDescription === "string" ? rawDescription.slice(0, 1000) : undefined;
    const media = files.find((r) => /\.mp4$/i.test(r.key));
    const poster = files.find((r) => /\.(jpg|jpeg|png|webp)$/i.test(r.key));
    const date = published ?? validDate(page.modified);
    const dateKind: DateKind = published ? "published" : date ? "modified" : "unknown";
    byId.set(`r2:${page.key}`, { id: `r2:${page.key}`, source: "r2", title, description,
      filenames: [name, ...(media ? [media.key.split("/")[1]] : [])],
      category: "videos", originalUrl: `${VIDEO}/${encodeKey(page.key)}`,
      mediaUrl: media ? `${VIDEO}/${encodeKey(media.key)}` : undefined,
      posterUrl: poster ? `${VIDEO}/${encodeKey(poster.key)}` : undefined,
      date, dateKind, collection: "video", day: localDay(date), dayKind: dateKind, layout: "video",
      publication: `r2:${token}`, primary: true, baseUrl: `${VIDEO}/${token}/` });
  }
  for (const [token, files] of groups) {
    const page = files.find((r) => !r.key.split("/")[1].includes("."));
    if (!page) continue;
    const manifest = enrichment[`${token}/gallery.json`]?.manifest;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) continue;
    const entry = manifest as Record<string, unknown>;
    if (!Array.isArray(entry.items) || !entry.items.length) continue;
    const rawGalleryTitle = entry.title;
    const gallery = typeof rawGalleryTitle === "string" && rawGalleryTitle.trim()
      ? rawGalleryTitle.slice(0, 300) : label(page.key.split("/")[1]);
    const galleryDescription = typeof entry.description === "string" ? entry.description.slice(0, 1000) : undefined;
    let validMembers = 0;
    for (const member of entry.items) {
      if (!member || typeof member !== "object" || Array.isArray(member)) continue;
      const m = member as Record<string, unknown>;
      const videoUrl = safePublishedUrl(m.video_url, VIDEO);
      const originalUrl = safePublishedUrl(m.entry_url, VIDEO);
      if (!originalUrl || !videoUrl || typeof m.name !== "string" || originalUrl.split("/").at(-1) !== encodeURIComponent(m.name)) continue;
      const memberToken = originalUrl.split("/")[3];
      if (!/^[a-f0-9]{16,64}$/.test(memberToken)
        || !groups.get(memberToken)?.some((r) => `${VIDEO}/${encodeKey(r.key)}` === originalUrl)
        || !groups.get(memberToken)?.some((r) => `${VIDEO}/${encodeKey(r.key)}` === videoUrl)
        || !/\.mp4$/i.test(new URL(videoUrl).pathname)) continue;
      const base = byId.get(`r2:${memberToken}/${m.name}`);
      if (!base) continue;
      const listedPoster = safePublishedUrl(m.poster_url, VIDEO);
      const posterUrl = listedPoster && groups.get(memberToken)?.some((r) => `${VIDEO}/${encodeKey(r.key)}` === listedPoster) ? listedPoster : base.posterUrl;
      const variantLabel = typeof m.label === "string" && m.label.trim() ? m.label.slice(0, 300) : undefined;
      const notes = typeof m.notes === "string" ? m.notes.slice(0, 1000) : undefined;
      const description = [...new Set([base.title, base.description, notes, galleryDescription].filter((s): s is string => !!s))]
        .filter((s) => s !== variantLabel).join(" · ").slice(0, 3000);
      byId.set(base.id, { ...base, title: variantLabel ?? base.title, description: description || undefined,
        mediaUrl: videoUrl, posterUrl, gallery, galleryUrl: `${VIDEO}/${encodeKey(page.key)}`, publication: `r2:${token}`,
        variant: typeof m.letter === "string" ? m.letter.slice(0, 4) : undefined });
      validMembers++;
    }
    // Keep a navigable page when a malformed manifest has no valid members.
    if (validMembers) byId.delete(`r2:${page.key}`);
  }
  return [...byId.values()];
}

export function boundaries(day: string, endDay: string, zone: string): [number, number] {
  const parse = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw Error("Invalid date");
    return s;
  };
  parse(day); parse(endDay);
  if (day > endDay) throw Error("Date range is reversed");
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const localDay = (instant: number) => {
    const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  // Search for the first instant whose local date is at least the target date.
  // This handles nonexistent or repeated midnight and entirely skipped days.
  const startOfDay = (s: string) => {
    const target = Date.parse(`${s}T00:00:00Z`);
    let lo = target - 2 * 86400000;
    let hi = target + 2 * 86400000;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (localDay(mid) < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const next = new Date(Date.parse(`${endDay}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return [startOfDay(day), startOfDay(next)];
}
/** A project folder named like a non-project collection stays its own collection. */
export const projectCollection = (project: string) => project === "share" || project === "video" ? `projects/${project}` : project;
const collectionOf = (item: Artifact) => item.collection ?? item.project ?? item.source;
const dayOf = (item: Artifact) => item.day ?? "undated";
// Newest day first; undated sorts after every dated day.
const byDayDesc = (a: string, b: string) => a === b ? 0 : a === "undated" ? 1 : b === "undated" ? -1 : b.localeCompare(a);
export type DayGroup = { collection: string; day: string; dayKinds: DateKind[]; matched: number; count: number; titles: string[]; hubUrl?: string; latest?: string };
export type DayNavigation = { collection: string; day: string; dayKinds: DateKind[]; count: number; hubUrl?: string; previous?: { day: string; count: number }; next?: { day: string; count: number } };

/** Navigator order: newest publication first, its primary first, then its other originals. */
export function orderDay(items: Artifact[]): Artifact[] {
  const latest = new Map<string, string>();
  for (const item of items) {
    const key = item.publication ?? item.id;
    if ((item.date ?? "") > (latest.get(key) ?? "")) latest.set(key, item.date ?? "");
    else if (!latest.has(key)) latest.set(key, "");
  }
  return [...items].sort((a, b) => {
    const pa = a.publication ?? a.id, pb = b.publication ?? b.id;
    return (latest.get(pb)!.localeCompare(latest.get(pa)!)) || pa.localeCompare(pb)
      || Number(!!b.primary) - Number(!!a.primary) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
}

function dayIndex(items: Artifact[]) {
  const index = new Map<string, Map<string, { count: number; kinds: Set<DateKind>; hubUrl?: string }>>();
  for (const item of items) {
    const days = index.get(collectionOf(item)) ?? new Map();
    index.set(collectionOf(item), days);
    const entry = days.get(dayOf(item)) ?? { count: 0, kinds: new Set<DateKind>() };
    entry.count++;
    entry.kinds.add(item.dayKind ?? (item.day ? item.dateKind : "unknown"));
    entry.hubUrl ??= item.hubUrl;
    days.set(dayOf(item), entry);
  }
  return index;
}

export function dayNavigation(items: Artifact[], collection: string, day: string): DayNavigation {
  const days = dayIndex(items.filter((item) => collectionOf(item) === collection)).get(collection) ?? new Map();
  const ordered = [...days.keys()].sort(byDayDesc);
  const at = ordered.indexOf(day);
  const entry = days.get(day);
  const pick = (d: string | undefined) => d === undefined ? undefined : { day: d, count: days.get(d)!.count };
  // previous = the next older day (later in newest-first order); next = the next newer day.
  const position = at >= 0 ? at : ordered.findIndex((d) => byDayDesc(d, day) > 0);
  const older = at >= 0 ? ordered[at + 1] : position >= 0 ? ordered[position] : undefined;
  const newer = at >= 0 ? ordered[at - 1] : position >= 0 ? ordered[position - 1] : ordered.at(-1);
  return { collection, day, dayKinds: entry ? [...entry.kinds].sort() : [], count: entry?.count ?? 0, hubUrl: entry?.hubUrl, previous: pick(older), next: pick(newer) };
}

export type CatalogQuery = { search?: string; type?: string; from?: string; to?: string; zone?: string; page?: string; limit?: string; project?: string; day?: string; group?: string };
function filterArtifacts(items: Artifact[], q: CatalogQuery) {
  if (q.type && !["all", "images", "videos", "audio", "pdfs", "other"].includes(q.type)) throw Error("Invalid type");
  if (q.zone) {
    if (q.zone.length > 80) throw Error("Invalid timezone");
    try { new Intl.DateTimeFormat("en-US", { timeZone: q.zone }); }
    catch { throw Error("Invalid timezone"); }
  }
  if (q.group && q.group !== "days") throw Error("Invalid group");
  if (q.project !== undefined && (!q.project || q.project.length > 200)) throw Error("Invalid project");
  if (q.day !== undefined && q.day !== "undated" && !isDay(q.day)) throw Error("Invalid day");
  if (q.day !== undefined && q.project === undefined) throw Error("A day needs its project");
  const viewDay = q.day !== undefined && !q.group;
  const page = Number(q.page ?? 1), limit = Number(q.limit ?? 24);
  if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(limit) || limit < 1 || limit > (viewDay ? 1000 : 100)) throw Error("Invalid pagination");
  if (!!q.from !== !!q.to) throw Error("Both dates are required");
  const bounds = q.from && q.to ? boundaries(q.from, q.to, q.zone ?? "UTC") : undefined;
  const term = (q.search ?? "").trim().toLocaleLowerCase();
  if (term.length > 200) throw Error("Search too long");
  // A dated folder is a calendar day, compared as one; everything else filters by its instant.
  const inRange = (item: Artifact) => item.layout === "dated" && item.day
    ? item.day >= q.from! && item.day <= q.to!
    : !!item.date && Date.parse(item.date) >= bounds![0] && Date.parse(item.date) < bounds![1];
  const placed = (item: Artifact) => (q.project === undefined || collectionOf(item) === q.project) && (q.day === undefined || dayOf(item) === q.day);
  const matches = items.filter((item) => placed(item) && (!q.type || q.type === "all" || item.category === q.type)
    && (!term || [item.title, item.description ?? "", item.gallery ?? "", item.project ?? "", item.collection ?? "", item.day ?? "", ...item.filenames].some((s) => s.toLocaleLowerCase().includes(term)))
    && (!bounds || inRange(item)));
  const excludedUnknownDates = bounds ? items.filter((i) => placed(i) && !i.date && !(i.layout === "dated" && i.day)).length : 0;
  return { matches, page, limit, excludedUnknownDates, viewDay };
}

/** Search results grouped into Collection → Day: the gallery's "By day" view. */
export function queryDayGroups(items: Artifact[], q: CatalogQuery) {
  const { matches, page, limit, excludedUnknownDates } = filterArtifacts(items, { ...q, group: q.group ?? "days" });
  const totals = dayIndex(items);
  const groups = new Map<string, DayGroup & { primaries: string[]; others: string[] }>();
  for (const item of matches) {
    const key = `${collectionOf(item)}\u0000${dayOf(item)}`;
    const total = totals.get(collectionOf(item))!.get(dayOf(item))!;
    const group = groups.get(key) ?? { collection: collectionOf(item), day: dayOf(item), dayKinds: [...total.kinds].sort(), matched: 0, count: total.count, titles: [], hubUrl: total.hubUrl, primaries: [], others: [] };
    group.matched++;
    (item.primary ? group.primaries : group.others).push(item.title);
    if ((item.date ?? "") > (group.latest ?? "")) group.latest = item.date;
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => byDayDesc(a.day, b.day) || a.collection.localeCompare(b.collection))
    .map(({ primaries, others, ...group }) => ({ ...group, titles: [...new Set([...primaries, ...others])].slice(0, 3) }));
  return { groups: ordered.slice((page - 1) * limit, page * limit), total: ordered.length, matched: matches.length, page, limit, excludedUnknownDates };
}

/** The flat gallery list, or, with project + day, that day in navigator order plus adjacency. */
export function queryArtifacts(items: Artifact[], q: CatalogQuery) {
  if (q.group) throw Error("Use queryDayGroups");
  const { matches, page, limit, excludedUnknownDates, viewDay } = filterArtifacts(items, q);
  if (viewDay) {
    const ordered = orderDay(matches);
    return { items: ordered.slice((page - 1) * limit, page * limit), total: ordered.length, page, limit, excludedUnknownDates,
      navigation: dayNavigation(items, q.project!, q.day!) as DayNavigation | undefined };
  }
  matches.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
  return { items: matches.slice((page - 1) * limit, page * limit), total: matches.length, page, limit, excludedUnknownDates, navigation: undefined as DayNavigation | undefined };
}

export function authorizeArtifacts(signature: string | undefined, timestamp: string | undefined, secret: string | undefined, now = Date.now()) {
  if (!secret || !signature || !timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 30000 || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(`artifacts:${timestamp}`).digest();
  return timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

export function createArtifactCatalog(loaders: { projects: () => Promise<Artifact[]>; share: () => Promise<Artifact[]>; r2: () => Promise<Artifact[]> }, ttl = 60000) {
  const states: Record<string, SourceResult> = { projects: { items: [], ok: false, stale: false }, share: { items: [], ok: false, stale: false }, r2: { items: [], ok: false, stale: false } };
  let nextRefresh = 0;
  let pending: Promise<void> | undefined;
  return async (force = false) => {
    if (!pending && (force || Date.now() >= nextRefresh)) {
      pending = (async () => {
        await Promise.all((Object.keys(loaders) as Array<keyof typeof loaders>).map(async (name) => {
          try { states[name] = { items: await loaders[name](), ok: true, stale: false, fetchedAt: new Date().toISOString() }; }
          catch { states[name] = { ...states[name], ok: false, stale: !!states[name].fetchedAt }; }
        }));
        nextRefresh = Date.now() + ttl;
      })().finally(() => { pending = undefined; });
    }
    await pending;
    const remaining = Math.max(0, nextRefresh - Date.now());
    return { items: Object.values(states).flatMap((s) => s.items), sources: { ...states }, retryAfterMs: remaining };
  };
}

// HTML5 character-reference decoding (complete named table, numeric/C1 rules,
// semicolon-less legacy names) from the maintained `entities` package. One pass only.
export const decodeHtmlEntities = (text: string): string => decodeHTML(text);
const attributes = (tag: string) => {
  const out: Record<string, string> = {};
  for (const m of tag.replace(/^<meta\b/i, "").matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const key = m[1].toLowerCase();
    if (!(key in out)) out[key] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
};
const clean = (value: string | undefined, decode: (s: string) => string) => value === undefined ? undefined : decode(value).replace(/\s+/g, " ").trim() || undefined;
// Metadata is read as inert text: nothing is parsed into a DOM, executed or mounted.
export function extractHtmlMetadata(html: string): { title?: string; description?: string } {
  const title = clean(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1], decodeHTML);
  let description: string | undefined;
  for (const [tag] of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = attributes(tag);
    if (attrs.name?.trim().toLowerCase() === "description" && "content" in attrs) { description = clean(attrs.content, decodeHTMLAttribute); break; }
  }
  return { title, description };
}

const run = async (command: string, args: string[], timeout: number) => (await exec(command, args, { timeout, maxBuffer: 64 * 1024 * 1024 })).stdout;
async function enrichMinio(items: Artifact[]) {
  const sites = items.filter((item) => /\.html?$/i.test(new URL(item.originalUrl).pathname));
  let cursor = 0;
  const deadline = AbortSignal.timeout(30000);
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (cursor < sites.length && !deadline.aborted) {
      const item = sites[cursor++];
      try {
        const res = await fetch(item.originalUrl, { signal: AbortSignal.any([deadline, AbortSignal.timeout(2500)]) });
        if (!res.ok || Number(res.headers.get("content-length") ?? 0) > 131072 || !res.body) { await res.body?.cancel(); continue; }
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (size <= 131072) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size <= 131072) chunks.push(value);
        }
        await reader.cancel();
        if (size > 131072) continue;
        const html = new TextDecoder().decode(Buffer.concat(chunks));
        const { title, description } = extractHtmlMetadata(html);
        if (title && title.length <= 300) item.title = title;
        if (description) item.description = description.slice(0, 1000);
      } catch { /* Metadata is optional; the listed original remains discoverable. */ }
    }
  }));
  return items;
}
export async function listMinio(bucket: "projects" | "share", listing = run) {
  const output = await listing("mc", ["ls", "--json", "--recursive", `delo/${bucket}/`], 120000);
  const rows = output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { status?: string; type?: string; key?: string; lastModified?: string });
  if (rows.some((r) => r.status === "error")) throw Error("Listing failed");
  return enrichMinio(normalizeMinio(bucket, rows.filter((r) => r.type === "file" && typeof r.key === "string").map((r) => ({ key: r.key!, modified: r.lastModified }))));
}
async function listR2() {
  const output = await run("/usr/bin/python3", [new URL("../scripts/artifacts-r2.py", import.meta.url).pathname], 120000);
  const payload = JSON.parse(output) as { objects: ObjectRow[]; enrichment: Enrichment };
  return normalizeR2(payload.objects, payload.enrichment);
}
/** Resolve an artifact (or one file of its bundle) to its published URL, through the catalog only. */
export function resolveTarget(item: Artifact, file?: string, download = false): { url: string; name: string } | undefined {
  let url: string;
  let name: string;
  if (file !== undefined) {
    if (!item.baseUrl || !item.filenames.includes(file) || !safeKey(file)) return;
    url = item.baseUrl + encodeKey(file);
    name = file;
  } else {
    url = download && item.mediaUrl ? item.mediaUrl : item.originalUrl;
    name = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "artifact");
  }
  const parsed = new URL(url);
  const allowed = parsed.protocol === "https:" && !parsed.search && !parsed.hash && !parsed.username && !parsed.password
    && ((parsed.origin === BASE && /^\/(?:projects|share)\//.test(parsed.pathname)) || parsed.origin === VIDEO);
  return allowed && safeKey(decodeURIComponent(parsed.pathname.slice(1))) ? { url: parsed.href, name: name.split("/").at(-1)! } : undefined;
}

type Fetcher = typeof fetch;
async function readCapped(body: ReadableStream<Uint8Array>, cap: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (size + value.byteLength > cap) { chunks.push(value.subarray(0, cap - size)); size = cap; over = true; break; }
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), over };
}

/** Build the sandboxed srcdoc for an HTML, Markdown or text artifact. Credentials are never sent. */
export async function artifactDocument(item: Artifact, file: string | undefined, fetcher: Fetcher = fetch) {
  const target = resolveTarget(item, file);
  if (!target || item.source === "r2") return { status: 404, body: { error: "No document for this artifact" } };
  const res = await fetcher(target.url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000), headers: { "user-agent": "holocene-artifacts/1" } });
  if (!res.ok || !res.body) { await res.body?.cancel(); return { status: 502, body: { error: `Original answered HTTP ${res.status}` } }; }
  const kind = documentKind(target.name, res.headers.get("content-type") ?? "");
  if (!kind) { await res.body.cancel(); return { status: 415, body: { kind: "binary", error: "No inline preview for this file type" } }; }
  const cap = kind === "text" ? TEXT_LIMIT : HTML_LIMIT;
  if (kind !== "text" && Number(res.headers.get("content-length") ?? 0) > cap) { await res.body.cancel(); return { status: 413, body: { kind, error: "Too large to render inline" } }; }
  const { text, over } = await readCapped(res.body, cap);
  if (over && kind !== "text") return { status: 413, body: { kind, error: "Too large to render inline" } };
  const baseUrl = target.url.slice(0, target.url.lastIndexOf("/") + 1);
  const srcdoc = kind === "html" ? wrapHtml(text, baseUrl) : kind === "markdown" ? renderMarkdown(text, baseUrl, target.name) : wrapText(text, baseUrl, target.name, over);
  return { status: 200, body: { kind, srcdoc, sourceUrl: target.url, baseUrl, truncated: over } };
}

const attachment = (name: string) => {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "artifact";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

/** The live catalog: one instance shared by the gallery routes and the project home (HOLOC-70). */
export const liveArtifactCatalog = () => createArtifactCatalog({ projects: () => listMinio("projects"), share: () => listMinio("share"), r2: listR2 });

export function registerArtifactRoutes(app: FastifyInstance, catalog = liveArtifactCatalog(), fetcher: Fetcher = fetch) {
  const signed = (req: { headers: Record<string, unknown> }) => authorizeArtifacts(req.headers["x-artifacts-signature"] as string | undefined, req.headers["x-artifacts-timestamp"] as string | undefined, process.env.TELEGRAM_HQ_BOT_TOKEN);
  const lookup = async (q: Record<string, string>) => {
    if (typeof q.id !== "string" || !q.id || q.id.length > 2048 || (q.file !== undefined && (typeof q.file !== "string" || q.file.length > 1024))) return;
    return (await catalog(false)).items.find((item) => item.id === q.id);
  };
  app.get<{ Querystring: Record<string, string> }>("/api/modules/artifacts/catalog", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!signed(req)) return reply.code(401).send({ error: "Unauthorized" });
    try {
      const snapshot = await catalog(req.query.refresh === "1");
      const result = req.query.group ? queryDayGroups(snapshot.items, req.query) : queryArtifacts(snapshot.items, req.query);
      const sources = Object.fromEntries(Object.entries(snapshot.sources).map(([name, state]) => [name, { ok: state.ok, stale: state.stale, fetchedAt: state.fetchedAt }]));
      return { ...result, sources, complete: Object.values(snapshot.sources).every((s) => s.ok), retryAfterMs: snapshot.retryAfterMs, zone: CATALOG_ZONE };
    } catch { return reply.code(400).send({ error: "Invalid catalog query" }); }
  });
  app.get<{ Querystring: Record<string, string> }>("/api/modules/artifacts/document", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!signed(req)) return reply.code(401).send({ error: "Unauthorized" });
    const item = await lookup(req.query);
    if (!item) return reply.code(404).send({ error: "Artifact not in the catalog" });
    try {
      const result = await artifactDocument(item, req.query.file, fetcher);
      return reply.code(result.status).send(result.body);
    } catch { return reply.code(502).send({ error: "Original unavailable" }); }
  });
  app.get<{ Querystring: Record<string, string> }>("/api/modules/artifacts/download", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!signed(req)) return reply.code(401).send({ error: "Unauthorized" });
    const item = await lookup(req.query);
    const target = item && resolveTarget(item, req.query.file, true);
    if (!target) return reply.code(404).send({ error: "Artifact not in the catalog" });
    try {
      const res = await fetcher(target.url, { credentials: "omit", redirect: "error", headers: { "user-agent": "holocene-artifacts/1" } });
      if (!res.ok || !res.body) { await res.body?.cancel(); return reply.code(502).send({ error: `Original answered HTTP ${res.status}` }); }
      reply.header("Content-Type", "application/octet-stream").header("Content-Disposition", attachment(target.name))
        .header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "sandbox; default-src 'none'");
      const length = res.headers.get("content-length");
      if (length && /^\d+$/.test(length)) reply.header("Content-Length", length);
      return reply.send(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream));
    } catch { return reply.code(502).send({ error: "Original unavailable" }); }
  });
}

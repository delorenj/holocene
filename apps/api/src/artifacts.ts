import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";

const exec = promisify(execFile);
export type Category = "images" | "videos" | "audio" | "pdfs" | "other";
export type Artifact = { id: string; source: "projects" | "share" | "r2"; project?: string; title: string; description?: string; filenames: string[]; category: Category; originalUrl: string; mediaUrl?: string; posterUrl?: string; date?: string; dateKind: "published" | "modified" | "unknown"; gallery?: string; galleryUrl?: string; variant?: string };
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

// Publish.py chooses index.html, then the only HTML, then the first file. A site is one
// publication; independently usable media/docs inside it retain their own original links.
export function normalizeMinio(bucket: "projects" | "share", rows: ObjectRow[]): Artifact[] {
  const groups = new Map<string, { project?: string; name: string; files: ObjectRow[] }>();
  for (const row of rows) {
    const parts = row.key.split("/");
    if (!safeKey(row.key) || parts.length < 3) continue;
    if (parts.some((p) => /^index-[0-9a-f]{12,64}\.html$/i.test(p))) continue;
    // Older session folders sometimes have loose files rather than an artifact subfolder.
    const prefix = bucket === "projects" ? parts.slice(0, parts.length === 3 ? 2 : 3) : parts.slice(0, 2);
    const id = prefix.join("/");
    const group = groups.get(id) ?? { project: bucket === "projects" ? parts[0] : undefined, name: prefix.at(-1)!, files: [] };
    group.files.push(row);
    groups.set(id, group);
  }
  const out: Artifact[] = [];
  for (const [prefix, group] of groups) {
    const files = group.files.sort((a, b) => a.key.localeCompare(b.key));
    const rel = (row: ObjectRow) => row.key.slice(prefix.length + 1);
    const html = files.find((r) => /^index\.html?$/i.test(rel(r))) ?? files.find((r) => /\.html?$/i.test(rel(r)));
    const useful = files.filter((r) => !SCAFFOLD.test(rel(r).split("/").at(-1)!) && (!/^(?:assets|static|_next)\//.test(rel(r)) || category(rel(r)) !== "other"));
    const primary = html ?? useful[0];
    if (!primary) continue;
    const loose = bucket === "projects" && prefix.split("/").length === 2;
    const newest = validDate(files.map((r) => r.modified).filter(Boolean).sort().at(-1));
    const make = (file: ObjectRow, isPrimary: boolean): Artifact => {
      const filename = rel(file);
      const url = `${BASE}/${bucket}/${encodeKey(file.key)}`;
      const kind = category(filename);
      return { id: `${bucket}:${file.key}`, source: bucket, project: group.project,
        title: isPrimary && !loose ? label(group.name) : label(filename.split("/").at(-1)!),
        filenames: isPrimary && !loose ? files.map(rel) : [filename], category: kind,
        originalUrl: url, mediaUrl: kind !== "other" ? url : undefined,
        date: validDate(file.modified) ?? newest, dateKind: validDate(file.modified) || newest ? "modified" : "unknown" };
    };
    out.push(make(primary, true));
    for (const file of useful) if (file !== primary) out.push(make(file, false));
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
  const out: Artifact[] = [];
  for (const [token, files] of groups) {
    const page = files.find((r) => !r.key.split("/")[1].includes("."));
    if (!page) continue;
    const name = page.key.split("/")[1];
    const manifest = enrichment[`${token}/gallery.json`]?.manifest;
    const entry = manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest as Record<string, unknown> : null;
    const items = Array.isArray(entry?.items) ? entry.items : [];
    const gallery = items.length > 0 ? String(entry?.title ?? name).slice(0, 300) : undefined;
    const rawTitle = enrichment[page.key]?.title;
    const title = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.slice(0, 300) : label(name);
    const published = validDate(enrichment[page.key]?.published);
    const description = enrichment[page.key]?.description?.slice(0, 1000);
    if (gallery) {
      for (const member of items) {
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
        const listedPoster = safePublishedUrl(m.poster_url, VIDEO);
        const posterUrl = listedPoster && groups.get(memberToken)?.some((r) => `${VIDEO}/${encodeKey(r.key)}` === listedPoster) ? listedPoster : undefined;
        out.push({ id: `r2:${memberToken}/${m.name}`, source: "r2", title: typeof m.label === "string" ? m.label.slice(0, 300) : label(m.name),
          description: typeof m.notes === "string" ? m.notes.slice(0, 1000) : undefined,
          filenames: [m.name], category: "videos", originalUrl, mediaUrl: videoUrl,
          posterUrl, date: validDate(page.modified),
          dateKind: validDate(page.modified) ? "modified" : "unknown", gallery,
          galleryUrl: `${VIDEO}/${encodeKey(page.key)}`,
          variant: typeof m.letter === "string" ? m.letter.slice(0, 4) : undefined });
      }
      continue;
    }
    const media = files.find((r) => /\.mp4$/i.test(r.key));
    const poster = files.find((r) => /\.(jpg|jpeg|png|webp)$/i.test(r.key));
    out.push({ id: `r2:${page.key}`, source: "r2", title, description, filenames: [name, ...(media ? [media.key.split("/")[1]] : [])],
      category: "videos", originalUrl: `${VIDEO}/${encodeKey(page.key)}`,
      mediaUrl: media ? `${VIDEO}/${encodeKey(media.key)}` : undefined,
      posterUrl: poster ? `${VIDEO}/${encodeKey(poster.key)}` : undefined,
      date: published ?? validDate(page.modified), dateKind: published ? "published" : validDate(page.modified) ? "modified" : "unknown" });
  }
  // The gallery manifest owns variant labels; replace the standalone page row for each member.
  const byId = new Map<string, Artifact>();
  for (const item of out) if (!item.gallery) byId.set(item.id, item);
  for (const item of out) if (item.gallery) byId.set(item.id, item);
  return [...byId.values()];
}

export function boundaries(day: string, endDay: string, zone: string): [number, number] {
  const parse = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw Error("Invalid date");
    return s;
  };
  parse(day); parse(endDay);
  if (day > endDay) throw Error("Date range is reversed");
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const midnight = (s: string) => {
    const target = Date.parse(`${s}T00:00:00Z`);
    let guess = target;
    for (let i = 0; i < 4; i++) {
      const parts = Object.fromEntries(dtf.formatToParts(guess).map((p) => [p.type, p.value]));
      const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
      const next = guess + target - local;
      if (next === guess) break;
      guess = next;
    }
    return guess;
  };
  const next = new Date(Date.parse(`${endDay}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return [midnight(day), midnight(next)];
}
export function queryArtifacts(items: Artifact[], q: { search?: string; type?: string; from?: string; to?: string; zone?: string; page?: string; limit?: string }) {
  if (q.type && !["all", "images", "videos", "audio", "pdfs", "other"].includes(q.type)) throw Error("Invalid type");
  if (q.zone && (q.zone.length > 80 || !Intl.supportedValuesOf("timeZone").includes(q.zone) && q.zone !== "UTC")) throw Error("Invalid timezone");
  const page = Number(q.page ?? 1), limit = Number(q.limit ?? 24);
  if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw Error("Invalid pagination");
  if (!!q.from !== !!q.to) throw Error("Both dates are required");
  const bounds = q.from && q.to ? boundaries(q.from, q.to, q.zone ?? "UTC") : undefined;
  const term = (q.search ?? "").trim().toLocaleLowerCase();
  if (term.length > 200) throw Error("Search too long");
  const matches = items.filter((item) => (!q.type || q.type === "all" || item.category === q.type)
    && (!term || [item.title, item.description ?? "", ...item.filenames].some((s) => s.toLocaleLowerCase().includes(term)))
    && (!bounds || (item.date && Date.parse(item.date) >= bounds[0] && Date.parse(item.date) < bounds[1])));
  matches.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
  return { items: matches.slice((page - 1) * limit, page * limit), total: matches.length, page, limit,
    excludedUnknownDates: bounds ? items.filter((i) => !i.date).length : 0 };
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

const run = async (command: string, args: string[], timeout: number) => (await exec(command, args, { timeout, maxBuffer: 64 * 1024 * 1024 })).stdout;
async function enrichMinio(items: Artifact[]) {
  const sites = items.filter((item) => /\/index\.html?$/i.test(item.originalUrl));
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
        const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
        const meta = html.match(/<meta\s+[^>]*name=["']description["'][^>]*>/i)?.[0];
        const description = meta?.match(/content=["']([^"']+)["']/i)?.[1]?.trim();
        if (title && title.length <= 300) item.title = title;
        if (description) item.description = description.slice(0, 1000);
      } catch { /* Metadata is optional; the listed original remains discoverable. */ }
    }
  }));
  return items;
}
async function listMinio(bucket: "projects" | "share") {
  const output = await run("mc", ["ls", "--json", "--recursive", `delo/${bucket}/`], 120000);
  const rows = output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { status?: string; type?: string; key?: string; lastModified?: string });
  if (rows.some((r) => r.status === "error")) throw Error("Listing failed");
  return enrichMinio(normalizeMinio(bucket, rows.filter((r) => r.type === "file" && typeof r.key === "string").map((r) => ({ key: r.key!, modified: r.lastModified }))));
}
async function listR2() {
  const output = await run("/usr/bin/python3", [new URL("../scripts/artifacts-r2.py", import.meta.url).pathname], 120000);
  const payload = JSON.parse(output) as { objects: ObjectRow[]; enrichment: Enrichment };
  return normalizeR2(payload.objects, payload.enrichment);
}
export function registerArtifactRoutes(app: FastifyInstance, catalog = createArtifactCatalog({ projects: () => listMinio("projects"), share: () => listMinio("share"), r2: listR2 })) {
  app.get<{ Querystring: Record<string, string> }>("/api/modules/artifacts/catalog", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!authorizeArtifacts(req.headers["x-artifacts-signature"] as string | undefined, req.headers["x-artifacts-timestamp"] as string | undefined, process.env.TELEGRAM_HQ_BOT_TOKEN)) return reply.code(401).send({ error: "Unauthorized" });
    try {
      const snapshot = await catalog(req.query.refresh === "1");
      const result = queryArtifacts(snapshot.items, req.query);
      const sources = Object.fromEntries(Object.entries(snapshot.sources).map(([name, state]) => [name, { ok: state.ok, stale: state.stale, fetchedAt: state.fetchedAt }]));
      return { ...result, sources, complete: Object.values(snapshot.sources).every((s) => s.ok), retryAfterMs: snapshot.retryAfterMs };
    } catch { return reply.code(400).send({ error: "Invalid catalog query" }); }
  });
}

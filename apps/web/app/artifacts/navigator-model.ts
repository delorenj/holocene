// HOLOC-69 day navigator: the pure half. The gallery cards, the "By day" groups, the navigator
// and its deep links all read placement through these helpers, so there is one model.

export type Category = "all" | "images" | "videos" | "audio" | "pdfs" | "other";
export type DateKind = "published" | "modified" | "unknown";
export type Item = {
  id: string; source: string; project?: string; title: string; description?: string; filenames: string[]; category: Category;
  originalUrl: string; mediaUrl?: string; posterUrl?: string; date?: string; dateKind: string; gallery?: string; galleryUrl?: string; variant?: string;
  collection?: string; day?: string; dayKind?: DateKind; layout?: "dated" | "session" | "share" | "video"; publication?: string; primary?: boolean; baseUrl?: string; hubUrl?: string;
};
export type DayGroup = { collection: string; day: string; dayKinds: DateKind[]; matched: number; count: number; titles: string[]; hubUrl?: string; latest?: string };
export type DayNavigation = { collection: string; day: string; dayKinds: DateKind[]; count: number; hubUrl?: string; previous?: { day: string; count: number }; next?: { day: string; count: number } };
export type NavState = { project: string; day: string; artifact?: string; file?: string };

export const CATALOG_ZONE = "America/New_York";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (value: string) => value === "undated" || (DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);

export const collectionOf = (item: Pick<Item, "collection" | "project" | "source">) => item.collection ?? item.project ?? item.source;
export const dayOf = (item: Pick<Item, "day">) => item.day ?? "undated";
export const placeOf = (item: Item): NavState => ({ project: collectionOf(item), day: dayOf(item), artifact: item.id });

/** `/artifacts?project=&day=&artifact=&file=`: the stable address of a navigator view. */
export function deepLink(state: NavState): string {
  const params = new URLSearchParams({ project: state.project, day: state.day });
  if (state.artifact) params.set("artifact", state.artifact);
  if (state.artifact && state.file) params.set("file", state.file);
  return `/artifacts?${params}`;
}

export function parseDeepLink(search: string): NavState | undefined {
  const params = new URLSearchParams(search);
  const project = params.get("project");
  const day = params.get("day");
  if (!project || project.length > 200 || !day || !isDay(day)) return;
  const artifact = params.get("artifact") ?? undefined;
  const file = params.get("file") ?? undefined;
  return { project, day, artifact: artifact && artifact.length <= 2048 ? artifact : undefined, file: artifact && file && file.length <= 1024 ? file : undefined };
}

export const sameView = (a?: NavState, b?: NavState) => (a?.project ?? "") === (b?.project ?? "") && (a?.day ?? "") === (b?.day ?? "") && (a?.artifact ?? "") === (b?.artifact ?? "") && (a?.file ?? "") === (b?.file ?? "");

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");
/** A bundle file's published URL: the publication folder plus its relative name. */
export function fileUrl(item: Item, name: string): string | undefined {
  return item.baseUrl && item.filenames.includes(name) ? item.baseUrl + encodeKey(name) : undefined;
}

const ext = (name: string) => name.split("/").at(-1)!.split(".").pop()?.toLowerCase() ?? "";
const nameOf = (url: string) => { try { return decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? ""); } catch { return ""; } };
const IMAGE = /^(?:jpe?g|png|gif|webp|avif|svg)$/;
const VIDEO = /^(?:mp4|mov|webm|m4v)$/;
const AUDIO = /^(?:mp3|m4a|wav|ogg|flac)$/;

/** How the main pane shows a file: native media, the browser PDF viewer, or a sandboxed document. */
export type ViewerKind = "image" | "video" | "audio" | "pdf" | "document" | "none";
export function viewerKind(item: Item, file?: string): ViewerKind {
  if (item.source === "r2") return (!file || VIDEO.test(ext(file))) && item.mediaUrl ? "video" : "none";
  const name = file ?? nameOf(item.originalUrl);
  const e = ext(name);
  if (IMAGE.test(e)) return "image";
  if (VIDEO.test(e)) return "video";
  if (AUDIO.test(e)) return "audio";
  if (e === "pdf") return "pdf";
  if (/^(?:woff2?|ttf|otf|eot|ico|zip|gz|tgz|tar|gpg|7z|wasm|bin|map)$/.test(e)) return "none";
  return "document";
}
export function mediaSource(item: Item, file?: string): string | undefined {
  if (file) return item.source === "r2" && VIDEO.test(ext(file)) ? item.mediaUrl : fileUrl(item, file);
  return item.mediaUrl ?? item.originalUrl;
}

/** Sandbox tokens per rendered kind. Never allow-same-origin, top navigation, forms or modals. */
export function sandboxFor(kind: string): string {
  return kind === "html" ? "allow-scripts allow-popups allow-popups-to-escape-sandbox" : "allow-popups allow-popups-to-escape-sandbox";
}

const target = (item: Item, file?: string) => { const p = new URLSearchParams({ id: item.id }); if (file) p.set("file", file); return p; };
export const documentHref = (item: Item, file?: string) => `/api/artifacts/document?${target(item, file)}`;
export const downloadHref = (item: Item, file?: string) => `/api/artifacts/download?${target(item, file)}`;

export function neighbours<T extends { id: string }>(items: T[], id?: string): { index: number; previous?: T; next?: T } {
  const index = id === undefined ? -1 : items.findIndex((item) => item.id === id);
  return { index, previous: index > 0 ? items[index - 1] : undefined, next: index >= 0 && index < items.length - 1 ? items[index + 1] : undefined };
}

/** Consecutive items sharing a publication (the API orders a day publication by publication). */
export function publications(items: Item[]): Array<{ publication: string; title: string; items: Item[] }> {
  const out: Array<{ publication: string; title: string; items: Item[] }> = [];
  for (const item of items) {
    const key = item.publication ?? item.id;
    const last = out.at(-1);
    if (last && last.publication === key) last.items.push(item);
    else out.push({ publication: key, title: item.gallery ?? item.title, items: [item] });
  }
  return out;
}

export function dayLabel(day: string): string {
  if (day === "undated") return "Undated";
  if (!isDay(day)) return day;
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
/** Says where a day comes from; a modified time is never called published. */
export function dayKindLabel(kinds: Array<DateKind | undefined>): string {
  const set = new Set(kinds.filter(Boolean));
  if (!set.size || (set.size === 1 && set.has("unknown"))) return "date unknown";
  if (set.size === 1 && set.has("published")) return "published day";
  if (set.size === 1 && set.has("modified")) return "day of last modification";
  return "published and modified days";
}
export function collectionLabel(collection: string): string {
  return collection === "share" ? "share links" : collection === "video" ? "video (R2)" : collection;
}

export function thumbOf(item: Item): { src?: string; glyph: string } {
  if (item.category === "images" && item.mediaUrl) return { src: item.mediaUrl, glyph: "IMG" };
  if (item.category === "videos") return { src: item.posterUrl, glyph: "VID" };
  if (item.category === "audio") return { glyph: "AUD" };
  if (item.category === "pdfs") return { glyph: "PDF" };
  const e = ext(nameOf(item.originalUrl));
  return { glyph: e === "html" || e === "htm" ? "HTML" : e === "md" || e === "markdown" ? "MD" : (e || "FILE").slice(0, 4).toUpperCase() };
}

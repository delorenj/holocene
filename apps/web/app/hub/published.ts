/** Published artifacts (v.delo.sh R2 video, s3.delo.sh MinIO files) resolved through the shared artifacts
 * catalog, matched by their exact share URL so a republish to the same name keeps working without edits. */
export type PublishedType = "all" | "images" | "videos" | "audio" | "pdfs" | "other";
export type PublishedRef = { originalUrl: string; search: string; type: PublishedType };

/** The catalog search term for a share URL: its last path segment (the folder, for an s3 index.html). */
export function refFor(originalUrl: string, type: PublishedType = "videos"): PublishedRef {
  let parts: string[] = [];
  try { parts = new URL(originalUrl).pathname.split("/").filter(Boolean); } catch { /* unparseable: empty search */ }
  if (parts.length > 1 && /^index\.html?$/i.test(parts[parts.length - 1])) parts.pop();
  return { originalUrl, search: decodeURIComponent(parts[parts.length - 1] ?? ""), type };
}

export function publishedQuery(ref: PublishedRef) {
  return new URLSearchParams({ search: ref.search, type: ref.type, page: "1", limit: "100", featured: "1" });
}

export function pickPublished<T extends { originalUrl: string }>(ref: Pick<PublishedRef, "originalUrl">, items: T[]) {
  return items.find((item) => item.originalUrl === ref.originalUrl);
}

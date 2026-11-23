/** Pinned catalog artifacts, matched by their published original URL so a republish to the
 * same name (same v.delo.sh token, or same MinIO path) keeps its place without an edit here.
 * `search` narrows the catalog query; it must appear in the artifact's title or filenames. */
export type FeaturedRef = { originalUrl: string; search: string; type: "all" | "images" | "videos" | "audio" | "pdfs" | "other"; note?: string };

export const FEATURED: FeaturedRef[] = [
  { originalUrl: "https://v.delo.sh/0803508f764df360/holocene-auto", search: "holocene-auto", type: "videos",
    note: "Holocene Auto on the Civic: Agent Pad roster and Record button, filmed in the car." }
];

export function featuredQuery(ref: FeaturedRef) {
  return new URLSearchParams({ search: ref.search, type: ref.type, page: "1", limit: "100", featured: "1" });
}
export function pickFeatured<T extends { originalUrl: string }>(ref: FeaturedRef, items: T[]) {
  return items.find((item) => item.originalUrl === ref.originalUrl);
}

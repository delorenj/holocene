/** Pinned catalog artifacts, matched by their published original URL so a republish to the
 * same name (same v.delo.sh token, or same MinIO path) keeps its place without an edit here.
 * `search` narrows the catalog query; it must appear in the artifact's title or filenames. */
export type FeaturedRef = { originalUrl: string; search: string; type: "all" | "images" | "videos" | "audio" | "pdfs" | "other"; title?: string; note?: string };

export const FEATURED: FeaturedRef[] = [
  { originalUrl: "https://v.delo.sh/01848684aa8a9d02/holocene-auto-agent-pad", search: "holocene-auto-agent-pad", type: "videos",
    title: "Holocene Auto", note: "Holocene Auto in the car: the Agent Pad roster and Record for Holocene, filmed on the dash." }
];

export function featuredQuery(ref: FeaturedRef) {
  return new URLSearchParams({ search: ref.search, type: ref.type, page: "1", limit: "100", featured: "1" });
}
export function pickFeatured<T extends { originalUrl: string }>(ref: FeaturedRef, items: T[]) {
  return items.find((item) => item.originalUrl === ref.originalUrl);
}

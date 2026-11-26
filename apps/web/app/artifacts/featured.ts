import { pickPublished, publishedQuery, type PublishedRef } from "../hub/published";

/** Pinned catalog artifacts, matched by their published original URL so a republish to the
 * same name (same v.delo.sh token, or same MinIO path) keeps its place without an edit here.
 * `search` narrows the catalog query; it must appear in the artifact's title or filenames. */
export type FeaturedRef = PublishedRef & { title?: string; note?: string };

export const FEATURED: FeaturedRef[] = [
  { originalUrl: "https://v.delo.sh/01848684aa8a9d02/holocene-auto-agent-pad", search: "holocene-auto-agent-pad", type: "videos",
    title: "Holocene Auto", note: "Holocene Auto in the car: the Agent Pad roster and Record for Holocene, filmed on the dash." }
];

export const featuredQuery = (ref: FeaturedRef) => publishedQuery(ref);
export const pickFeatured = <T extends { originalUrl: string }>(ref: FeaturedRef, items: T[]) => pickPublished(ref, items);

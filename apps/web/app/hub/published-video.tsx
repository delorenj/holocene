"use client";
import { useEffect, useState } from "react";
import { pickPublished, publishedQuery, refFor, type PublishedRef } from "./published";

export type PublishedItem = {
  id: string; source: string; project?: string; title: string; description?: string; category: string;
  originalUrl: string; mediaUrl?: string; posterUrl?: string; date?: string; dateKind: string;
};
export type PublishedState<T extends PublishedItem = PublishedItem> = { item?: T; status: "loading" | "found" | "missing" | "error" };

function browserZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** Resolve one share URL to its catalog item (playable media URL and poster). */
export function usePublished<T extends PublishedItem = PublishedItem>(ref: PublishedRef, zone?: string, retry = 0): PublishedState<T> {
  const [state, setState] = useState<PublishedState<T>>({ status: "loading" });
  const { originalUrl, search, type } = ref;
  useEffect(() => {
    const controller = new AbortController();
    const params = publishedQuery({ originalUrl, search, type }); params.set("zone", zone ?? browserZone());
    fetch(`/api/artifacts/catalog?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw Error(); return response.json() as Promise<{ items: T[]; complete: boolean }>; })
      .then((result) => { const item = pickPublished({ originalUrl }, result.items ?? []); setState(item ? { item, status: "found" } : { status: result.complete ? "missing" : "error" }); })
      .catch(() => { if (!controller.signal.aborted) setState({ status: "error" }); });
    return () => controller.abort();
  }, [originalUrl, search, type, zone, retry]);
  return state;
}

/** A published demo video in a 16:9 frame. Falls back to a link to the share page while the catalog cannot place it. */
export function PublishedVideo({ url, title, className }: { url: string; title: string; className?: string }) {
  const { item, status } = usePublished(refFor(url));
  return <figure className={`hub-video${className ? ` ${className}` : ""}`}>
    <div className="hub-video-frame">
      {item?.mediaUrl
        ? <video controls playsInline preload={item.posterUrl ? "none" : "metadata"} poster={item.posterUrl} src={item.mediaUrl} aria-label={title} />
        : <p role="status" className="hub-video-placeholder">{status === "loading" ? "Loading video…" : status === "missing" ? "This video is no longer in the catalog." : "Video unavailable while the catalog is incomplete."}</p>}
    </div>
    <figcaption><span>{title}</span><a href={url} target="_blank" rel="noopener noreferrer">Open share page<span aria-hidden="true"> ↗</span><span className="hub-sr-only"> (new tab)</span></a></figcaption>
  </figure>;
}

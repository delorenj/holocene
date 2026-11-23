"use client";

import { useEffect, useRef, useState } from "react";
import { HubShell } from "../hub/hub-shell";
import { Brand, ThemeToggle, useTheme } from "../hub/hub-app";
import { NavIcon } from "../hub/nav-icons";
import { FEATURED, featuredQuery, pickFeatured, type FeaturedRef } from "./featured";

type Category = "all" | "images" | "videos" | "audio" | "pdfs" | "other";
type Item = { id: string; source: string; project?: string; title: string; description?: string; filenames: string[]; category: Category; originalUrl: string; mediaUrl?: string; posterUrl?: string; date?: string; dateKind: string; gallery?: string; galleryUrl?: string; variant?: string };
type ResponseData = { items: Item[]; total: number; page: number; limit: number; retryAfterMs: number; excludedUnknownDates: number; complete: boolean; sources: Record<string, { ok: boolean; stale: boolean; fetchedAt?: string }> };
const types: Array<[Category, string]> = [["all", "All files"], ["images", "Images"], ["videos", "Videos"], ["audio", "Audio"], ["pdfs", "PDFs"], ["other", "Other"]];

function Preview({ item }: { item: Item }) {
  const [broken, setBroken] = useState(false);
  if (!item.mediaUrl || broken) return <div className="artifact-fallback">Preview unavailable. Open the published original below.</div>;
  if (item.category === "images") return <img loading="lazy" src={item.mediaUrl} alt={item.title} onError={() => setBroken(true)} />;
  if (item.category === "videos") return <video controls preload="none" poster={item.posterUrl} src={item.mediaUrl} onError={() => setBroken(true)} />;
  if (item.category === "audio") return <audio controls preload="none" src={item.mediaUrl} onError={() => setBroken(true)} />;
  if (item.category === "pdfs") return <div className="artifact-fallback">PDF · Open the published original to view the document.</div>;
  return <div className="artifact-fallback">Open the published original to view this file.</div>;
}

const sourceTag = (state: { ok: boolean; stale: boolean }) => state.ok ? "is-cleared" : state.stale ? "is-stuck" : "is-broken";

function FeaturedEntry({ entry, zone, retry }: { entry: FeaturedRef; zone: string; retry: number }) {
  const [state, setState] = useState<{ item?: Item; status: "loading" | "found" | "missing" | "error" }>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    const params = featuredQuery(entry); params.set("zone", zone);
    fetch(`/api/artifacts/catalog?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw Error(); return response.json() as Promise<ResponseData>; })
      .then((result) => { const item = pickFeatured(entry, result.items); setState(item ? { item, status: "found" } : { status: result.complete ? "missing" : "error" }); })
      .catch(() => { if (!controller.signal.aborted) setState({ status: "error" }); });
    return () => controller.abort();
  }, [entry, zone, retry]);
  const item = state.item;
  if (!item) return <article className="artifact-featured is-placeholder">
    <p role="status">{state.status === "loading" ? "Loading featured artifact…" : state.status === "missing" ? "This featured artifact is no longer in the catalog." : "Featured artifact unavailable while catalog sources are incomplete."} <a href={entry.originalUrl} target="_blank" rel="noopener noreferrer">Open the published original ↗</a></p>
  </article>;
  return <article className="artifact-featured">
    <div className="artifact-featured-media">{item.category === "videos" && item.mediaUrl
      ? <video controls playsInline preload={item.posterUrl ? "none" : "metadata"} poster={item.posterUrl} src={item.mediaUrl} aria-label={item.title} />
      : <Preview item={item} />}</div>
    <div className="artifact-featured-body">
      <p className="hub-chips"><span className="hub-tag">{item.category}</span><span className="hub-chip">{item.source}{item.project ? ` · ${item.project}` : ""}</span></p>
      <h3>{item.title}</h3>
      {entry.note ? <p>{entry.note}</p> : null}
      {item.description && item.description !== entry.note && item.description !== item.title ? <p>{item.description}</p> : null}
      <p className="artifact-date">{item.date ? `${item.dateKind === "published" ? "Published" : "Modified"} ${new Date(item.date).toLocaleString(undefined, { timeZone: zone })}` : "Date unknown"}</p>
      <div className="artifact-links"><a href={item.originalUrl} target="_blank" rel="noopener noreferrer">Open share page ↗</a></div>
    </div>
  </article>;
}

export function ArtifactsApp() {
  const [theme, toggleTheme] = useTheme();
  const [search, setSearch] = useState("");
  const [type, setType] = useState<Category>("all");
  const [mode, setMode] = useState<"files" | "pictures" | "video">("files");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const forceRefresh = useRef(false);
  const requestGeneration = useRef(0);
  const refresh = () => { forceRefresh.current = true; setRetry((v) => v + 1); };
  const [data, setData] = useState<ResponseData>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [zone, setZone] = useState<{ name: string; fallback: boolean }>({ name: "UTC", fallback: true });
  useEffect(() => {
    try {
      const name = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (name) { new Intl.DateTimeFormat("en-US", { timeZone: name }); setZone({ name, fallback: false }); }
    } catch { /* UTC is explicitly shown below */ }
  }, []);
  useEffect(() => {
    const generation = ++requestGeneration.current;
    if ((from && !to) || (!from && to)) { setError("Choose both start and end dates (the same date for one day)."); setLoading(false); return; }
    if (from && to && from > to) { setError("The end date must not be before the start date."); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError("");
    const params = new URLSearchParams({ search, type: mode === "pictures" ? "images" : mode === "video" ? "videos" : type, page: String(page), zone: zone.name });
    if (from && to) { params.set("from", from); params.set("to", to); }
    const timer = setTimeout(() => {
      if (forceRefresh.current) { params.set("refresh", "1"); forceRefresh.current = false; }
      fetch(`/api/artifacts/catalog?${params}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => { if (!response.ok) throw Error(response.status === 401 ? "Catalog access denied." : "Catalog unavailable. Try again."); return response.json() as Promise<ResponseData>; })
        .then((result) => { if (!controller.signal.aborted && generation === requestGeneration.current) { setData(result); setLoading(false); } })
        .catch((reason: unknown) => { if (!controller.signal.aborted && generation === requestGeneration.current) { setError(reason instanceof Error ? reason.message : "Catalog unavailable. Try again."); setLoading(false); } });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, type, mode, from, to, page, zone.name, retry]);
  useEffect(() => {
    if (!data || data.complete || error || loading) return;
    const timer = setTimeout(refresh, Math.max(1000, data.retryAfterMs + 100));
    return () => clearTimeout(timer);
  }, [data, error, loading]);
  const updateSearch = (v: string) => { setSearch(v); setPage(1); };
  const changeMode = (v: "files" | "pictures" | "video") => { setMode(v); setPage(1); };
  return <main className="hub-root artifacts-shell" data-theme={theme}>
    <HubShell current="artifacts"><Brand /><div className="hub-header-end"><ThemeToggle theme={theme} onToggle={toggleTheme} /></div></HubShell>
    <div className="artifact-content" id="hub-content" tabIndex={-1}><div className="artifact-heading"><p className="hub-label">Published library</p><h1>Artifacts</h1><p>Files in MinIO and video publications in R2, together.</p></div>
    {FEATURED.length ? <section className="hub-panel artifact-featured-panel" aria-labelledby="artifacts-featured">
      <div className="hub-panel-head"><NavIcon name="genesis" /><h2 id="artifacts-featured">Featured</h2><span className="hub-panel-count">{FEATURED.length}<span className="hub-sr-only"> pinned</span></span><span className="hub-panel-meta">pinned by published URL · plays from R2</span></div>
      <div className="hub-panel-body artifact-featured-list">{FEATURED.map((entry) => <FeaturedEntry key={entry.originalUrl} entry={entry} zone={zone.name} retry={retry} />)}</div>
    </section> : null}
    <section className="hub-panel artifact-browse" aria-labelledby="artifacts-browse">
    <div className="hub-panel-head is-quiet"><NavIcon name="settings" /><h2 id="artifacts-browse">Browse</h2><span className="hub-panel-meta">search, type and date filters</span></div>
    <div className="artifact-controls" aria-label="Browse artifacts" role="group">
      <div className="artifact-modes" aria-label="Gallery mode">
        {([["files", "All files"], ["pictures", "Picture gallery"], ["video", "Video gallery"]] as const).map(([id, text]) => <button key={id} type="button" aria-pressed={mode === id} onClick={() => changeMode(id)}>{text}</button>)}
      </div>
      <div className="artifact-filters">
        <label>Search metadata<input value={search} placeholder="Title, filename or description" onChange={(event) => updateSearch(event.target.value)} /></label>
        <label>Type<select disabled={mode !== "files"} value={mode === "files" ? type : mode === "pictures" ? "images" : "videos"} onChange={(event) => { setType(event.target.value as Category); setPage(1); }}>{types.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>From<input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label>
        <label>Through<input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></label>
        <button type="button" onClick={() => { setFrom(""); setTo(""); setPage(1); }}>Clear dates</button>
      </div>
      <p className="artifact-timezone">Dates use {zone.name}{zone.fallback ? " (UTC fallback; browser timezone unavailable)" : " (browser timezone)"}. Each selected day includes local midnight, excluding midnight of the following day. Items without a known date are excluded from date filters.</p>
    </div></section>
    <section className="hub-panel artifact-results-panel" aria-labelledby="artifacts-results">
    <div className="hub-panel-head"><NavIcon name="artifacts" /><h2 id="artifacts-results">Results</h2>{!loading && data && !error ? <span className="hub-panel-count">{data.total}<span className="hub-sr-only"> {data.total === 1 ? "result" : "results"}</span></span> : null}<span className="hub-panel-meta">{mode === "files" ? "all published files" : mode === "pictures" ? "picture gallery" : "video gallery"}</span></div>
    <div className="artifact-results" aria-live="polite">
      {error && <div className="artifact-alert" role="alert">{error} <button type="button" onClick={refresh}>Retry</button></div>}
      {loading && <p>Loading catalog…</p>}
      {!loading && data && !error && <>
        <div className="artifact-status"><strong>{data.total} {data.total === 1 ? "result" : "results"}</strong><button type="button" onClick={refresh}>Refresh sources</button></div>
        <ul className="artifact-sources">{Object.entries(data.sources).map(([name, state]) => <li key={name} className="hub-chip"><span className={`hub-tag ${sourceTag(state)}`}>{state.ok ? "ok" : state.stale ? "stale" : "down"}</span> {name}: {state.ok ? "available" : state.stale ? "unavailable · showing cached snapshot" : "unavailable"}{state.fetchedAt ? ` · fetched ${new Date(state.fetchedAt).toLocaleString()}` : " · no snapshot"}</li>)}</ul>
        {!data.complete && <p className="artifact-alert">{Object.values(data.sources).some((s) => s.ok || s.stale) ? "Results are incomplete. One or more sources are unavailable; cached items may be stale." : "All sources are unavailable. No current catalog could be loaded."} Retrying automatically while this page is open; Refresh sources retries now.</p>}
        {data.excludedUnknownDates > 0 && <p>{data.excludedUnknownDates} undated items excluded by the date filter.</p>}
        {!data.items.length && <p className="artifact-empty">{data.complete ? "No artifacts match these filters." : "No results from the available sources. Other sources may still contain matches."}</p>}
        <div className={`artifact-grid ${mode !== "files" ? "is-gallery" : ""}`}>{data.items.map((item) => <article className="artifact-card" key={item.id}>
          <div className="artifact-preview"><Preview key={item.id} item={item} /></div>
          <div className="artifact-card-body"><p className="artifact-meta"><span className="hub-tag">{item.category}</span> {item.project ? `${item.project} · ` : ""}{item.source}{item.variant ? ` · variant ${item.variant}` : ""}</p>
            <h3>{item.title}</h3>{item.description && <p>{item.description}</p>}{item.gallery && <p className="artifact-gallery-label">Gallery: {item.gallery}</p>}
            <p className="artifact-date">{item.date ? `${item.dateKind === "published" ? "Published" : "Modified"} ${new Date(item.date).toLocaleString(undefined, { timeZone: zone.name })}` : "Date unknown"}</p>
            <div className="artifact-links"><a href={item.originalUrl} target="_blank" rel="noopener noreferrer">Open original ↗</a>{item.galleryUrl && <a href={item.galleryUrl} target="_blank" rel="noopener noreferrer">Open gallery ↗</a>}</div>
          </div></article>)}</div>
        {data.total > data.limit && <nav className="artifact-pagination" aria-label="Result pages"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {Math.ceil(data.total / data.limit)}</span><button disabled={page * data.limit >= data.total} onClick={() => setPage(page + 1)}>Next</button></nav>}
      </>}
    </div></section></div>
  </main>;
}

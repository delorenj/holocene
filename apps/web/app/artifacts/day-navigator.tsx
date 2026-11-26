"use client";

import { useEffect, useRef, useState } from "react";
import { CATALOG_ZONE, collectionLabel, dayKindLabel, dayLabel, deepLink, documentHref, downloadHref, fileUrl, mediaSource, neighbours, publications, sandboxFor, thumbOf, viewerKind, type DayNavigation, type Item, type NavState } from "./navigator-model";

type DayResponse = { items: Item[]; total: number; navigation?: DayNavigation; complete: boolean };
type DocResponse = { kind?: string; srcdoc?: string; truncated?: boolean; error?: string };

/** One rendered file. Markup only ever runs in a srcdoc iframe without allow-same-origin. */
function Viewer({ item, file, theme }: { item: Item; file?: string; theme: string }) {
  const kind = viewerKind(item, file);
  const src = mediaSource(item, file);
  const [doc, setDoc] = useState<DocResponse & { status?: number }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setDoc(undefined);
    if (kind !== "document") return;
    const controller = new AbortController();
    fetch(documentHref(item, file), { cache: "no-store", signal: controller.signal })
      .then(async (res) => ({ status: res.status, ...(await res.json().catch(() => ({ error: "Unreadable response" }))) as DocResponse }))
      .then((result) => { if (!controller.signal.aborted) setDoc(result); })
      .catch(() => { if (!controller.signal.aborted) setDoc({ status: 0, error: "Document unavailable." }); });
    return () => controller.abort();
  }, [item.id, file, kind, retry]);
  const label = file ?? item.title;
  if (kind === "image" && src) return <img className="artifact-nav-media" src={src} alt={label} />;
  if (kind === "video" && src) return <video className="artifact-nav-media" controls playsInline preload="metadata" poster={file ? undefined : item.posterUrl} src={src} aria-label={label} />;
  if (kind === "audio" && src) return <div className="artifact-nav-fallback"><p>{label}</p><audio controls preload="metadata" src={src} aria-label={label} /></div>;
  // The browser PDF viewer, in a frame from s3.delo.sh (cross-origin to Holocene).
  if (kind === "pdf" && src) return <iframe className="artifact-nav-frame" src={src} title={`PDF: ${label}`} referrerPolicy="no-referrer" />;
  if (kind === "document") {
    if (!doc) return <p className="artifact-nav-fallback" role="status">Rendering {label}…</p>;
    if (doc.srcdoc && doc.kind) return <iframe key={`${item.id}|${file ?? ""}`} className={`artifact-nav-frame is-${doc.kind}`} sandbox={sandboxFor(doc.kind)} srcDoc={doc.srcdoc}
      referrerPolicy="no-referrer" allow="" title={`${doc.kind === "html" ? "Sandboxed page" : doc.kind === "markdown" ? "Markdown" : "Text"}: ${label}`} style={{ colorScheme: theme.endsWith("night") ? "dark" : "light" }} data-kind={doc.kind} />;
    const message = doc.status === 415 ? "No inline preview for this file type." : doc.status === 413 ? "Too large to render inline." : doc.error ?? "Document unavailable.";
    return <div className="artifact-nav-fallback" role="status"><p>{message} Use Open original or Download.</p>{doc.status !== 415 && doc.status !== 413 ? <button type="button" onClick={() => setRetry((v) => v + 1)}>Retry</button> : null}</div>;
  }
  return <p className="artifact-nav-fallback">No inline preview for this file. Use Open original or Download.</p>;
}

export function DayNavigator({ state, theme, onNavigate, onClose }: { state: NavState; theme: string; onNavigate: (next: NavState) => void; onClose: () => void }) {
  const [data, setData] = useState<DayResponse>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState<{ ok: boolean; link: string }>();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prior = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    root.current?.focus();
    return () => { document.documentElement.style.overflow = prior; opener?.focus?.(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined); setError("");
    const params = new URLSearchParams({ project: state.project, day: state.day, limit: "1000" });
    fetch(`/api/artifacts/catalog?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (res) => { if (!res.ok) throw Error(res.status === 401 ? "Catalog access denied." : "This day is unavailable. Try again."); return res.json() as Promise<DayResponse>; })
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "This day is unavailable."); });
    return () => controller.abort();
  }, [state.project, state.day, retry]);
  useEffect(() => setCopied(undefined), [state.artifact, state.file, state.day]);

  const items = data?.items ?? [];
  const selected = items.find((item) => item.id === state.artifact) ?? items[0];
  const missing = !!data && !!state.artifact && !items.some((item) => item.id === state.artifact);
  const file = selected && state.artifact === selected.id && state.file && selected.filenames.includes(state.file) ? state.file : undefined;
  const { previous, next } = neighbours(items, selected?.id);
  const nav = data?.navigation;
  const select = (item: Item, name?: string) => onNavigate({ project: state.project, day: state.day, artifact: item.id, file: name });
  const goDay = (day: string) => onNavigate({ project: state.project, day });
  const current: NavState | undefined = selected ? { project: state.project, day: state.day, artifact: selected.id, file } : undefined;
  const original = selected ? (file ? fileUrl(selected, file) : selected.originalUrl) : undefined;
  const copy = async () => {
    if (!current) return;
    const link = `${window.location.origin}${deepLink(current)}`;
    try { await navigator.clipboard.writeText(link); setCopied({ ok: true, link }); }
    catch { setCopied({ ok: false, link }); }
  };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    const tag = (event.target as HTMLElement).tagName;
    if (["INPUT", "SELECT", "TEXTAREA", "VIDEO", "AUDIO"].includes(tag) || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "ArrowRight" && next) { event.preventDefault(); select(next); }
    if (event.key === "ArrowLeft" && previous) { event.preventDefault(); select(previous); }
  };
  const groups = publications(items);

  return <div className="artifact-nav" role="dialog" aria-modal="true" aria-labelledby="artifact-nav-title" tabIndex={-1} ref={root} onKeyDown={onKey}>
    <header className="artifact-nav-head">
      <button type="button" className="artifact-nav-close" onClick={onClose}>← Gallery</button>
      <div className="artifact-nav-place">
        <p className="hub-label">{collectionLabel(state.project)} · {nav ? dayKindLabel(nav.dayKinds) : "day"}</p>
        <h2 id="artifact-nav-title">{dayLabel(state.day)}</h2>
        <p className="artifact-nav-sub">{data ? `${data.total} ${data.total === 1 ? "artifact" : "artifacts"}` : "Loading day…"} · days in {CATALOG_ZONE}</p>
      </div>
      <nav className="artifact-nav-days" aria-label="Adjacent days">
        <button type="button" disabled={!nav?.previous} onClick={() => nav?.previous && goDay(nav.previous.day)} aria-label={nav?.previous ? `Previous day, ${dayLabel(nav.previous.day)}` : "No previous day"}>← {nav?.previous ? nav.previous.day : "Previous day"}</button>
        <button type="button" disabled={!nav?.next} onClick={() => nav?.next && goDay(nav.next.day)} aria-label={nav?.next ? `Next day, ${dayLabel(nav.next.day)}` : "No next day"}>{nav?.next ? nav.next.day : "Next day"} →</button>
        {nav?.hubUrl ? <a href={nav.hubUrl} target="_blank" rel="noopener noreferrer">Published day index ↗</a> : null}
      </nav>
    </header>
    <div className="artifact-nav-body">
      <section className="artifact-nav-main" aria-label="Selected artifact">
        {error ? <div className="artifact-alert" role="alert">{error} <button type="button" onClick={() => setRetry((v) => v + 1)}>Retry</button></div> : null}
        {data && !data.complete ? <p className="artifact-alert">Some catalog sources are unavailable; this day may be incomplete.</p> : null}
        {missing ? <p className="artifact-alert" role="status">That artifact is no longer in this day. Showing the first artifact instead.</p> : null}
        {data && !items.length ? <p className="artifact-empty">No artifacts on this day in {collectionLabel(state.project)}.</p> : null}
        {selected ? <>
          <div className="artifact-nav-toolbar">
            <div className="artifact-nav-title">
              <p className="artifact-meta"><span className="hub-tag">{selected.category}</span> {selected.layout === "session" ? "session folder" : selected.layout ?? selected.source}{selected.filenames.length > 1 && selected.primary ? ` · bundle of ${selected.filenames.length} files` : ""}</p>
              <h3>{file ? file : selected.title}</h3>
              {file ? <p className="artifact-nav-file">File in <button type="button" className="artifact-nav-link" onClick={() => select(selected)}>{selected.title}</button></p> : null}
              <p className="artifact-date">{selected.date ? `${selected.dateKind === "published" ? "Published" : "Modified"} ${new Date(selected.date).toLocaleString(undefined, { timeZone: CATALOG_ZONE })}` : "Time unknown"}{selected.dayKind === "published" && selected.dateKind !== "published" ? " · day from its dated folder" : ""}</p>
            </div>
            <div className="artifact-nav-actions">
              <button type="button" disabled={!previous} onClick={() => previous && select(previous)}>← Previous</button>
              <button type="button" disabled={!next} onClick={() => next && select(next)}>Next →</button>
              {original ? <a className="artifact-nav-btn" href={original} target="_blank" rel="noopener noreferrer">Open original ↗</a> : null}
              <button type="button" onClick={copy}>Copy link</button>
              <a className="artifact-nav-btn" href={downloadHref(selected, file)} download>Download</a>
            </div>
            {copied ? <p className="artifact-nav-copied" role="status">{copied.ok ? "Link copied." : "Copy blocked by the browser; select the link:"} {!copied.ok ? <input readOnly value={copied.link} aria-label="Link to this artifact" onFocus={(event) => event.currentTarget.select()} /> : null}</p> : null}
          </div>
          <div className="artifact-nav-stage"><Viewer key={`${selected.id}|${file ?? ""}`} item={selected} file={file} theme={theme} /></div>
          {selected.filenames.length > 1 ? <details className="artifact-nav-files" open={!!file}>
            <summary>Publication files ({selected.filenames.length})</summary>
            <ul>{selected.filenames.map((name) => {
              const url = fileUrl(selected, name);
              const viewable = viewerKind(selected, name) !== "none";
              return <li key={name} className={name === file ? "is-current" : undefined}>
                <span className="artifact-nav-filename">{name}</span>
                <span className="artifact-nav-filelinks">{viewable ? <button type="button" className="artifact-nav-link" onClick={() => select(selected, name)}>View</button> : null}
                  {url ? <a href={url} target="_blank" rel="noopener noreferrer">Open ↗</a> : null}
                  <a href={downloadHref(selected, name)} download>Download</a></span>
              </li>;
            })}</ul>
          </details> : null}
        </> : !data && !error ? <p role="status">Loading day…</p> : null}
      </section>
      <aside className="artifact-nav-list" aria-label="Artifacts in this day">
        {groups.map((group) => <section key={group.publication} className="artifact-nav-pub">
          {group.items.length > 1 ? <p className="artifact-nav-pubhead">{group.title} <span>· {group.items.length}</span></p> : null}
          <ul>{group.items.map((item) => {
            const thumb = thumbOf(item);
            return <li key={item.id}><button type="button" className="artifact-nav-entry" aria-current={item.id === selected?.id ? "true" : undefined} onClick={() => select(item)}>
              <span className="artifact-nav-thumb" aria-hidden="true">{thumb.src ? <img src={thumb.src} alt="" loading="lazy" /> : thumb.glyph}</span>
              <span className="artifact-nav-entrytext"><strong>{item.title}</strong><span>{item.category}{item.filenames.length > 1 && item.primary ? ` · ${item.filenames.length} files` : ""}{item.date ? ` · ${new Date(item.date).toLocaleTimeString(undefined, { timeZone: CATALOG_ZONE, hour: "numeric", minute: "2-digit" })}` : ""}</span></span>
            </button></li>;
          })}</ul>
        </section>)}
      </aside>
    </div>
  </div>;
}

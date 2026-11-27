"use client";

// HOLOC-70 review: a preserved revision in an opaque-origin frame, annotated through Plannotator's
// bridge protocol (v2). Holocene owns the host side; the page and everything it posts stay untrusted.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ANNOTATION_HIGHLIGHT_CSS, BRIDGE_SCRIPT } from "@plannotator/ui/components/html-viewer/bridge-script";
import { buildPersistedHtmlAnchor } from "@plannotator/core/html-anchor";
import { HubShell } from "../hub/hub-shell";
import { Brand, ThemeToggle, useTheme } from "../hub/hub-app";
import { CATALOG_ZONE, sandboxFor } from "../artifacts/navigator-model";
import {
  anchorLabel, apiBase, BRIDGE_PREFIX, BRIDGE_VERSION, identityMessage, injectBridge, numbering, projectHref, readBridge,
  restoreMessages, saveOutcome, shortHash, type Annotation, type Project, type RevisionView, type SaveState
} from "./review-model";

type Mode = "drag" | "pinpoint" | "interact";
type Draft = { id: string; quote: string; kind: "text" | "element"; anchor: Record<string, unknown>; comment: string; version?: number; save: SaveState; fresh: boolean };
type Loaded = { project: Project; revision: RevisionView; annotations: Annotation[]; viewer?: string };

const when = (iso?: string) => iso ? new Date(iso).toLocaleString(undefined, { timeZone: CATALOG_ZONE, dateStyle: "medium", timeStyle: "short" }) : "";
// randomUUID exists only in secure contexts; getRandomValues works everywhere (RFC 4122 v4 either way).
const uuid = (): string => typeof crypto.randomUUID === "function" ? crypto.randomUUID()
  : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));

async function call(url: string, method: string, body?: unknown): Promise<{ status: number; body: { error?: string; annotation?: Annotation } }> {
  try {
    const res = await fetch(url, { method, cache: "no-store", headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? {} : await res.json().catch(() => ({})) };
  } catch {
    return { status: 0, body: {} };
  }
}

export function ReviewView({ projectId, revision }: { projectId: string; revision: string }) {
  const [theme, toggleTheme] = useTheme();
  const [data, setData] = useState<Loaded>();
  const [srcdoc, setSrcdoc] = useState<string>();
  const [failure, setFailure] = useState<{ status: number; error?: string }>();
  const [mode, setMode] = useState<Mode>("drag");
  const [draft, setDraft] = useState<Draft>();
  const [current, setCurrent] = useState<string>();
  const [unanchored, setUnanchored] = useState<Set<string>>(new Set());
  // The per-load key: each load is a fresh iframe element, so only that load's window can ever be event.source.
  const [loadKey, setLoadKey] = useState(uuid);
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef<{ data?: Loaded; draft?: Draft; mode: Mode }>({ mode });
  latest.current = { data, draft, mode };
  const base = `${apiBase(projectId)}/revisions/${revision}`;

  const post = useCallback((msg: Record<string, unknown>) => {
    if (ready.current) frame.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const get = (url: string) => fetch(url, { cache: "no-store", signal: controller.signal }).then(async (res) => ({ res, body: await res.json().catch(() => ({})) }));
    Promise.all([get(base), get(`${base}/document`)]).then(([meta, doc]) => {
      if (controller.signal.aborted) return;
      const bad = !meta.res.ok ? meta : !doc.res.ok ? doc : undefined;
      if (bad) { setFailure({ status: bad.res.status, error: bad.body.error }); return; }
      setData(meta.body as Loaded);
      setSrcdoc(injectBridge((doc.body as { srcdoc: string }).srcdoc, ANNOTATION_HIGHLIGHT_CSS, BRIDGE_SCRIPT));
    }).catch(() => { if (!controller.signal.aborted) setFailure({ status: 0, error: "Network error" }); });
    return () => controller.abort();
  }, [base]);

  const numbers = useMemo(() => numbering(data?.annotations ?? []), [data]);
  const ordered = useMemo(() => [...(data?.annotations ?? [])].sort((a, b) => (numbers.get(a.id) ?? 1e9) - (numbers.get(b.id) ?? 1e9) || a.createdAt.localeCompare(b.createdAt)), [data, numbers]);

  const putAnnotation = (a: Annotation) => setData((d) => d && { ...d, annotations: d.annotations.some((x) => x.id === a.id) ? d.annotations.map((x) => x.id === a.id ? a : x) : [...d.annotations, a] });
  const sync = useCallback((list: Annotation[]) => post({ type: `${BRIDGE_PREFIX}sync-annotations`, annotations: [...numbering(list)].map(([id, number]) => ({ id, number })) }), [post]);
  useEffect(() => { if (data) sync(data.annotations); }, [data, sync]);

  // The queued writer reads the draft from this ref, so every write inside it lands there at once
  // (not on the next render): a Save queued behind an autosave sees the autosave's version and id.
  const updateDraft = useCallback((fn: (x: Draft | undefined) => Draft | undefined) => {
    latest.current = { ...latest.current, draft: fn(latest.current.draft) };
    setDraft(fn); // still an updater, so a keystroke queued meanwhile is not lost (fn is pure)
  }, []);
  // One writer at a time: autosave and Save never race each other's version numbers.
  const persist = useCallback((status: "draft" | "saved") => {
    queue.current = queue.current.then(async () => {
      const d = latest.current.draft;
      if (!d || (status === "draft" && !d.comment.trim())) return;
      updateDraft((x) => x && x.id === d.id ? { ...x, save: { state: "saving" } } : x);
      const res = d.version === undefined
        ? await call(`${base}/annotations`, "POST", { id: d.id, status, kind: d.kind, anchor: d.anchor, comment: d.comment })
        : await call(`${base}/annotations/${d.id}`, "PATCH", status === "saved" ? { version: d.version, comment: d.comment, status } : { version: d.version, comment: d.comment });
      const outcome = saveOutcome(res.status, res.body);
      const saved = res.body.annotation;
      if (outcome.state === "saved" && saved) {
        putAnnotation(saved);
        if (status === "saved") {
          if (d.fresh) post({ type: `${BRIDGE_PREFIX}cancel-selection` });
          post({ type: `${BRIDGE_PREFIX}find-and-mark`, id: d.id, annotationType: "comment", structural: true, originalText: d.quote, anchor: d.anchor.htmlAnchor, additionalAnchors: d.anchor.htmlAdditionalTargets });
          // Only the draft that was saved closes; a newer selection made while saving keeps its own id and version.
          updateDraft((x) => !x || x.id !== d.id ? x : x.comment === d.comment ? undefined : { ...x, version: saved.version, fresh: false, save: { state: "idle" } });
          setCurrent(d.id);
          return;
        }
        updateDraft((x) => x && x.id === d.id ? { ...x, version: saved.version, save: { state: "saved" } } : x);
        return;
      }
      const current = res.body.annotation;
      if (outcome.state === "conflict" && current) {
        // Adopt the server's version so the next explicit Save overwrites knowingly; the operator's text stays in the box.
        putAnnotation(current);
        updateDraft((x) => x && x.id === d.id ? { ...x, version: current.version, save: { state: "conflict", error: `Changed elsewhere (now: “${current.comment.slice(0, 120)}”). Save again to replace it with your text.` } } : x);
        return;
      }
      if (res.status === 404 && d.version !== undefined) {
        // Deleted elsewhere: drop the stale row and marker; the operator's text stays in the box (a Save re-creates it as new).
        post({ type: `${BRIDGE_PREFIX}remove-mark`, id: d.id });
        setData((x) => x && { ...x, annotations: x.annotations.filter((a) => a.id !== d.id) });
        const reborn = uuid(); // outside the updater: React may run an updater more than once
        updateDraft((x) => x && x.id === d.id ? { ...x, id: reborn, version: undefined, fresh: true, save: { state: "failed", error: "Deleted elsewhere. Your text is kept; press Save to add it as a new annotation" } } : x);
        return;
      }
      updateDraft((x) => x && x.id === d.id ? { ...x, save: outcome } : x);
    });
  }, [base, post, updateDraft]);

  // Drafts persist as you type (debounced), so a reload or API restart keeps the words.
  useEffect(() => {
    if (!draft || !draft.comment.trim() || draft.save.state === "saving" || draft.save.state === "conflict") return;
    const stored = data?.annotations.find((a) => a.id === draft.id);
    // A saved annotation changes only on Save; drafts and new comments persist as you type.
    if (stored && (stored.status === "saved" || stored.comment === draft.comment)) return;
    const t = setTimeout(() => persist("draft"), 900);
    return () => clearTimeout(t);
  }, [draft?.comment, draft?.id, persist]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== "null") return;
      const msg = readBridge(event.data);
      if (!msg) return;
      if (msg.type === "ready") {
        if (msg.protocolVersion !== BRIDGE_VERSION) { setFailure({ status: 0, error: `Annotation bridge protocol ${msg.protocolVersion} is not supported` }); return; }
        ready.current = true;
        const { mode: m, data: d } = latest.current;
        post({ type: `${BRIDGE_PREFIX}set-annotate-mode`, active: m !== "interact" });
        post({ type: `${BRIDGE_PREFIX}set-input-method`, method: m === "pinpoint" ? "pinpoint" : "drag" });
        for (const out of restoreMessages(d?.annotations ?? [])) post(out);
        return;
      }
      if (!ready.current) return;
      if (msg.type === "selection") {
        const persisted = buildPersistedHtmlAnchor({ originalText: msg.text, htmlAnchor: msg.anchor as never, elementContext: msg.context as never }).anchor as unknown as Record<string, unknown>;
        const prior = latest.current.draft;
        setDraft({ id: prior?.fresh && prior.version === undefined ? prior.id : uuid(), quote: msg.text, kind: msg.pinpoint ? "element" : "text", anchor: persisted, comment: prior?.fresh && prior.version === undefined ? prior.comment : "", save: { state: "idle" }, fresh: true });
      } else if (msg.type === "selection-clear") {
        setDraft((d) => d && d.fresh && !d.comment.trim() ? undefined : d);
      } else if (msg.type === "mark-click") {
        setCurrent(msg.id);
        document.getElementById(`review-item-${msg.id}`)?.scrollIntoView({ block: "nearest" });
      } else if (msg.type === "unanchored") {
        setUnanchored(new Set(msg.ids));
      } else if (msg.type === "resize" && frame.current) {
        frame.current.style.height = `${Math.max(msg.height, 480)}px`;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post]);

  const choose = (m: Mode) => {
    setMode(m);
    post({ type: `${BRIDGE_PREFIX}set-annotate-mode`, active: m !== "interact" });
    if (m !== "interact") post({ type: `${BRIDGE_PREFIX}set-input-method`, method: m });
  };
  const focus = (id: string) => {
    setCurrent(id);
    post({ type: `${BRIDGE_PREFIX}scroll-to`, id, behavior: "smooth" });
    post({ type: `${BRIDGE_PREFIX}focus-mark`, id });
  };
  const edit = (a: Annotation) => setDraft({ id: a.id, quote: typeof a.anchor.originalText === "string" ? a.anchor.originalText : anchorLabel(a.anchor), kind: a.kind, anchor: a.anchor, comment: a.comment, version: a.version, save: { state: "idle" }, fresh: false });
  const cancel = () => {
    if (draft?.fresh) post({ type: `${BRIDGE_PREFIX}cancel-selection` });
    setDraft(undefined);
  };
  const remove = async (a: Annotation) => {
    const res = await call(`${base}/annotations/${a.id}?version=${a.version}`, "DELETE");
    if (res.status === 204) {
      post({ type: `${BRIDGE_PREFIX}remove-mark`, id: a.id });
      setData((d) => d && { ...d, annotations: d.annotations.filter((x) => x.id !== a.id) });
      if (draft?.id === a.id) setDraft(undefined);
    } else {
      if (res.body.annotation) putAnnotation(res.body.annotation);
      window.alert(`Not deleted: ${saveOutcome(res.status, res.body).error}`);
    }
  };
  const reloadFrame = () => { ready.current = false; setUnanchored(new Set()); setLoadKey(uuid()); };

  const rev = data?.revision;
  return <main className="hub-root projects-shell is-review" data-theme={theme}>
    <HubShell current="artifacts"><Brand /><div className="hub-header-end"><ThemeToggle theme={theme} onToggle={toggleTheme} /></div></HubShell>
    <div className="project-content" id="hub-content" tabIndex={-1}>
      <div className="review-head">
        <div>
          <p className="hub-label"><a href={projectHref(projectId)}>{data?.project.name ?? projectId}</a> · Review</p>
          <h1>{rev?.title ?? "Preserved revision"}</h1>
          {rev ? <p className="project-meta"><span title={rev.revisionId}>rev {shortHash(rev.revisionId)}</span> · preserved {when(rev.createdAt)} by {rev.createdBy} · entry sha256 <code>{shortHash(rev.entrySha256)}</code></p> : null}
        </div>
        {rev ? <div className="project-actions">
          <a className="hub-btn" href={rev.snapshotUrl} target="_blank" rel="noopener noreferrer">Preserved copy ↗</a>
          <a className="hub-btn" href={rev.sourceUrl} target="_blank" rel="noopener noreferrer">Original ↗</a>
        </div> : null}
      </div>
      {failure ? <div className="project-alert" role="alert">{failure.status === 409 ? `The preserved copy no longer matches its recorded hash; it will not be shown. ${failure.error ?? ""}` : identityMessage(failure.status, projectId, failure.error)}</div> : null}
      {!data && !failure ? <p role="status">Loading the preserved revision…</p> : null}
      {data && srcdoc ? <div className="review-body">
        <div className="review-stage">
          <iframe key={loadKey} data-load={loadKey} ref={frame} className="review-frame" title={`Preserved revision of ${rev?.title ?? "walkthrough"}`}
            sandbox={sandboxFor("html")} referrerPolicy="no-referrer" srcDoc={srcdoc} />
        </div>
        <aside className="review-rail" aria-label="Annotations">
          <div className="review-toolbar" role="group" aria-label="Annotation input">
            <button type="button" aria-pressed={mode === "drag"} onClick={() => choose("drag")}>Select text</button>
            <button type="button" aria-pressed={mode === "pinpoint"} onClick={() => choose("pinpoint")}>Pin element</button>
            <button type="button" aria-pressed={mode === "interact"} onClick={() => choose("interact")}>Interact</button>
            <button type="button" onClick={reloadFrame} title="Reload the preserved page and re-place every annotation">Re-place</button>
          </div>
          {draft ? <form className="review-composer" onSubmit={(e) => { e.preventDefault(); if (draft.comment.trim()) persist("saved"); }}>
            <p className="hub-label">{draft.fresh ? "New annotation" : "Edit annotation"}</p>
            <p className="review-quote">{draft.kind === "element" && !draft.quote ? anchorLabel(draft.anchor) : `“${draft.quote.length > 240 ? `${draft.quote.slice(0, 237)}…` : draft.quote}”`}</p>
            <label className="hub-label" htmlFor="review-comment">Comment</label>
            <textarea id="review-comment" value={draft.comment} maxLength={10000} autoFocus
              onChange={(e) => { const comment = e.target.value; setDraft((d) => d && { ...d, comment, save: d.save.state === "conflict" ? d.save : { state: "idle" } }); }} />
            <div className="review-item-actions">
              <button type="submit" disabled={!draft.comment.trim() || draft.save.state === "saving"}>Save</button>
              <button type="button" onClick={cancel}>{draft.version !== undefined && draft.fresh ? "Close (draft kept)" : "Cancel"}</button>
            </div>
            <p className={`review-save is-${draft.save.state}`} role="status" aria-live="polite">
              {draft.save.state === "saving" ? "Saving…" : draft.save.state === "saved" ? "Draft saved" : draft.save.state === "failed" ? `Not saved: ${draft.save.error}. Your text is kept; press Save to retry.` : draft.save.state === "conflict" ? `Not saved: ${draft.save.error}` : draft.version !== undefined ? "Draft saved" : "Not saved yet"}
            </p>
          </form> : <p className="project-meta">{mode === "interact" ? "Interact mode: the page behaves normally. Switch to Select text or Pin element to annotate." : mode === "pinpoint" ? "Click an element in the page to pin a comment to it." : "Select text in the page to comment on it."}</p>}
          <p className="hub-label">{numbers.size} saved · {(data.annotations.length - numbers.size)} {data.annotations.length - numbers.size === 1 ? "draft" : "drafts"}</p>
          <ol className="review-list">
            {ordered.map((a) => {
              const n = numbers.get(a.id);
              const lost = unanchored.has(a.id);
              const mine = !data.viewer || data.viewer === a.author;
              return <li key={a.id} id={`review-item-${a.id}`} className={`review-item${lost ? " is-unresolved" : ""}`} aria-current={current === a.id ? "true" : undefined}>
                <div className="review-item-meta"><span>{n ? `#${n}` : "draft"}</span><span>{a.author}</span><span>{when(a.updatedAt)}</span>{lost ? <span className="hub-tag is-stuck">anchor not found in this revision</span> : null}</div>
                <button type="button" className="review-quote" style={{ textAlign: "left", background: "none", border: 0, padding: "0 0 0 8px", cursor: "pointer" }} onClick={() => focus(a.id)}>{anchorLabel(a.anchor)}</button>
                <p>{a.comment || <em>(empty draft)</em>}</p>
                {mine ? <div className="review-item-actions">
                  <button type="button" onClick={() => edit(a)}>Edit</button>
                  <button type="button" onClick={() => { if (window.confirm("Delete this annotation?")) void remove(a); }}>Delete</button>
                </div> : null}
              </li>;
            })}
          </ol>
          {!data.annotations.length ? <p className="project-meta">No annotations on this revision yet.</p> : null}
        </aside>
      </div> : null}
    </div>
  </main>;
}

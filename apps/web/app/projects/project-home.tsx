"use client";

import { useEffect, useState } from "react";
import { HubShell } from "../hub/hub-shell";
import { Brand, ThemeToggle, useTheme } from "../hub/hub-app";
import { CATALOG_ZONE } from "../artifacts/navigator-model";
import { apiBase, galleryLink, identityMessage, latestLabel, reviewHref, revisionsOf, shortHash, type HomePayload, type Walkthrough } from "./review-model";

const when = (iso?: string) => iso ? new Date(iso).toLocaleString(undefined, { timeZone: CATALOG_ZONE, dateStyle: "medium", timeStyle: "short" }) : "time unknown";
const sourceTag = (s: { ok: boolean; stale: boolean }) => s.ok ? "is-cleared" : s.stale ? "is-stuck" : "is-broken";

function WalkthroughCard({ w, home, onCaptured }: { w: Walkthrough; home: HomePayload; onCaptured: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revisions = revisionsOf(home, w.id);
  const capture = async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch(`${apiBase(home.project.id)}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artifactId: w.id }) });
      const body = await res.json().catch(() => ({})) as { error?: string; revision?: { revisionId: string } };
      if (!res.ok || !body.revision) throw Error(body.error ?? `HTTP ${res.status}`);
      window.location.assign(reviewHref(home.project.id, body.revision.revisionId));
    } catch (reason) {
      setError(`Could not preserve this revision: ${reason instanceof Error ? reason.message : "unknown error"}`);
      setBusy(false);
      onCaptured();
    }
  };
  return <article className="project-walk">
    <div className="project-walk-head">
      <div>
        <p className="hub-label">HTML walkthrough · {w.day ?? "undated"}{w.files > 1 ? ` · ${w.files} files` : ""}</p>
        <h3>{w.title}</h3>
        {w.description ? <p className="project-walk-desc">{w.description}</p> : null}
        <p className="project-meta">Latest publication {when(w.date)}</p>
      </div>
      <div className="project-actions">
        <button type="button" className="hub-btn is-primary" disabled={busy} onClick={capture}>{busy ? "Preserving…" : revisions.length ? "Review latest" : "Start review"}</button>
        <a className="hub-btn" href={w.originalUrl} target="_blank" rel="noopener noreferrer">Original ↗</a>
        <a className="hub-btn" href={galleryLink(w)}>In Artifacts</a>
      </div>
    </div>
    {error ? <p className="project-alert" role="alert">{error}</p> : null}
    {revisions.length ? <ol className="project-revisions" aria-label={`Reviewed revisions of ${w.title}`}>
      {revisions.map((r) => <li key={r.revisionId} className={`project-rev is-${r.latest.state}`}>
        <a href={reviewHref(home.project.id, r.revisionId)} className="project-rev-link">
          <span className="project-rev-hash" title={r.revisionId}>rev {shortHash(r.revisionId)}</span>
          <span>preserved {when(r.createdAt)}</span>
          <span>{r.saved} {r.saved === 1 ? "annotation" : "annotations"}{r.drafts ? ` · ${r.drafts} ${r.drafts === 1 ? "draft" : "drafts"}` : ""}</span>
        </a>
        <span className={`hub-tag ${r.latest.state === "current" ? "is-cleared" : "is-stuck"}`}>{latestLabel(r)}</span>
        <span className="project-rev-links"><a href={r.snapshotUrl} target="_blank" rel="noopener noreferrer">Preserved copy ↗</a> <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer">Original ↗</a></span>
      </li>)}
    </ol> : <p className="project-meta">No reviewed revision yet. Starting a review preserves these exact bytes first.</p>}
  </article>;
}

export function ProjectHome({ projectId }: { projectId: string }) {
  const [theme, toggleTheme] = useTheme();
  const [home, setHome] = useState<HomePayload>();
  const [failure, setFailure] = useState<{ status: number; error?: string }>();
  const [retry, setRetry] = useState(0);
  const [refresh, setRefresh] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setFailure(undefined);
    fetch(`${apiBase(projectId)}/home${refresh ? "?refresh=1" : ""}`, { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({})) as HomePayload & { error?: string };
        if (controller.signal.aborted) return;
        if (!res.ok) { setFailure({ status: res.status, error: body.error }); return; }
        setHome(body);
      })
      .catch(() => { if (!controller.signal.aborted) setFailure({ status: 0, error: "Network error" }); })
      .finally(() => setRefresh(false));
    return () => controller.abort();
  }, [projectId, retry]);

  return <main className="hub-root projects-shell" data-theme={theme}>
    <HubShell current="artifacts"><Brand /><div className="hub-header-end"><ThemeToggle theme={theme} onToggle={toggleTheme} /></div></HubShell>
    <div className="project-content" id="hub-content" tabIndex={-1}>
      <div className="project-heading">
        <p className="hub-label">Project home</p>
        <h1>{home?.project.name ?? projectId}</h1>
        {home ? <p className="project-identity"><code>{home.project.id}</code>{home.project.board ? <> · board <code>{home.project.board}</code></> : null} · <code>{home.project.repoPath}</code></p> : null}
      </div>
      {failure ? <div className="project-alert" role="alert">{identityMessage(failure.status, projectId, failure.error)} {failure.status === 503 || failure.status === 0 ? <button type="button" onClick={() => setRetry((v) => v + 1)}>Retry</button> : null}</div> : null}
      {!home && !failure ? <p role="status">Resolving project…</p> : null}
      {home ? <>
        <section className="hub-panel" aria-labelledby="project-walks">
          <div className="hub-panel-head"><h2 id="project-walks">Walkthroughs</h2><span className="hub-panel-count">{home.walkthroughs.length}</span><span className="hub-panel-meta">HTML publications in the {home.project.id} collection</span></div>
          <div className="hub-panel-body project-walks">
            <ul className="project-sources" aria-label="Catalog sources">
              {Object.entries(home.sources).map(([name, s]) => <li key={name}><span className={`hub-tag ${sourceTag(s)}`}>{s.ok ? "fresh" : s.stale ? "stale" : "down"}</span>{name}{s.fetchedAt ? ` · ${when(s.fetchedAt)}` : ""}</li>)}
              <li><button type="button" onClick={() => { setRefresh(true); setRetry((v) => v + 1); }}>Refresh catalog</button></li>
            </ul>
            {!home.complete ? <p className="project-alert" role="status">Some catalog sources are unavailable; this list may be incomplete.</p> : null}
            {home.walkthroughs.length ? home.walkthroughs.map((w) => <WalkthroughCard key={w.id} w={w} home={home} onCaptured={() => setRetry((v) => v + 1)} />)
              : <p className="project-meta">No HTML publication in this project's collection yet. Publish one with the artifacts publisher (<code>--project {home.project.id}</code>).</p>}
            <p className="project-meta">{home.otherArtifacts} other {home.otherArtifacts === 1 ? "file" : "files"} in this collection · <a href={home.walkthroughs[0] ? galleryLink(home.walkthroughs[0]) : "/artifacts"}>browse in Artifacts</a>.
              {home.unattributed.share || home.unattributed.video ? ` ${home.unattributed.share} share and ${home.unattributed.video} video publications carry no project attribution and are not assigned here.` : ""}</p>
          </div>
        </section>
      </> : null}
    </div>
  </main>;
}

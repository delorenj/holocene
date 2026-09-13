"use client";

/*
THESIS: Trace native hooks through Bloodbank normalization to the work they run.
OWN-WORLD: Inherit Holocene's navy surfaces, blue selection and semantic status colors.
STORY: Choose an event or CLI, inspect its wiring, then open an execution receipt.
FIRST VIEWPORT: Compact header, 210px explorer, stacked normalized/native panels,
attached handlers and the newest receipts. Counts on hooks mean handlers.
FORM: User's Excalidraw structure refined with Google Stitch project
16143358374491232683, screen 919e509947ca4713abcbfbdc39c1e8cf. No generated sample
measurements are shipped. Configuration and observed execution remain distinct.
*/

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  CLI_NAMES, CLI_ORDER, FAILED, durationLabel, eventName, handlerName, invocationDuration,
  normalizedGroups, statusLabel, type HookBinding, type HookExecution, type HookHistory,
  type HookInvocation, type HookSnapshot,
} from "./model";

const POLL_MS = 4000;
const PAGE_SIZE = 25;

function State({ value }: { value: string }) {
  const tone = FAILED.has(value) ? "bad" : ["succeeded", "completed", "active", "running", "installed", "healthy"].includes(value) ? "good" : ["skipped", "deduplicated", "pending", "selected"].includes(value) ? "warn" : "quiet";
  const symbol = tone === "bad" ? "×" : value === "succeeded" || value === "completed" ? "✓" : value === "deduplicated" ? "↪" : tone === "warn" ? "−" : "○";
  return <span className={`hook-state hook-state-${tone}`}><span aria-hidden="true">{symbol}</span>{statusLabel(value)}</span>;
}

function timestamp(value?: string | null, full = false) {
  if (!value) return "Not observed";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  return full ? date.toLocaleString() : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

async function loadJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `Hook data could not be loaded (HTTP ${response.status}).`);
  }
  return response.json();
}

function Receipt({ invocation, loading }: { invocation: HookInvocation; loading: boolean }) {
  const publication = invocation.executions.filter((e) => e.publish_status != null || /publish/.test(e.handler_id));
  return <div className="hook-receipt" aria-label={`Receipt ${invocation.invocation_id}`}>
    <div className="hook-receipt-heading"><div><h3>Execution receipt</h3><code>{invocation.invocation_id}</code></div><State value={invocation.status} /></div>
    <dl className="hook-receipt-facts">
      <div><dt>Received</dt><dd>{timestamp(invocation.received_at, true)}</dd></div>
      <div><dt>Session</dt><dd><code>{invocation.session_id || "Not supplied by CLI"}</code></dd></div>
      <div><dt>Duplicate protection</dt><dd>{invocation.identity_kind?.replaceAll("_", " ") || "Invocation ID"}{invocation.deduplicated ? ` · ${invocation.deduplicated} suppressed` : ""}</dd></div>
      <div><dt>Bloodbank publication</dt><dd>{publication.length ? publication.map((e) => <span key={e.handler_id}>{statusLabel(e.publish_status ?? e.status)}{e.event_id ? <code className="hook-block">{e.event_id}</code> : null}</span>) : "No publication receipt"}</dd></div>
    </dl>
    <div className="hook-table-scroll"><table className="hook-executions"><thead><tr><th>Handler</th><th>Mode</th><th>Outcome</th><th>Duration</th><th>Detail</th></tr></thead><tbody>
      {invocation.executions.map((e: HookExecution) => <tr key={e.handler_id}><td>{handlerName(e.handler_id)}<code className="hook-block hook-dim">{e.handler_id}</code></td><td>{e.mode}</td><td><State value={e.status} /></td><td className="hook-mono">{durationLabel(e.duration_ms)}</td><td className="hook-execution-reason">{e.reason || (e.exit_code != null ? `Exit ${e.exit_code}` : "—")}</td></tr>)}
    </tbody></table></div>
    {loading ? <p className="hook-dim" role="status">Loading lifecycle details…</p> : invocation.timeline?.length ? <details className="hook-timeline"><summary>Lifecycle timeline <span>{invocation.timeline.length} transitions</span></summary><ol>{invocation.timeline.map((step) => <li key={step.sequence}><time>{timestamp(step.at)}</time><span>{step.handler_id ? handlerName(step.handler_id) : "Hook ingress"}</span><State value={step.status} /></li>)}</ol></details> : null}
    <p className="hook-dim hook-footnote">Receipts contain execution metadata. Prompt and transcript contents are not displayed.</p>
  </div>;
}

export function HookObservatory() {
  const [snapshot, setSnapshot] = useState<HookSnapshot | null>(null);
  const [history, setHistory] = useState<HookHistory | null>(null);
  const [cli, setCli] = useState("claude");
  const [native, setNative] = useState("UserPromptSubmit");
  const [role, setRole] = useState("prompt_submit");
  const [handler, setHandler] = useState("");
  const [search, setSearch] = useState("");
  const [receiptStatus, setReceiptStatus] = useState("");
  const [followSelection, setFollowSelection] = useState(false);
  const [offset, setOffset] = useState(0);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HookInvocation | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const requestGeneration = useRef(0);

  const hubIssue = snapshot?.hub.transport_error === "socket_path_missing"
    ? "The native hook socket is missing. CLI hooks cannot reach the hub."
    : snapshot?.hub.transport_error || snapshot?.hub.registry_error || snapshot?.hub.journal_error;
  const bindings = useMemo(() => (snapshot?.bindings ?? []).filter((binding) => !["planned", "unsupported"].includes(binding.support_status ?? "")), [snapshot?.bindings]);
  const groups = useMemo(() => normalizedGroups(bindings.filter((binding) => binding.event_type)), [bindings]);
  const cliBindings = bindings.filter((b) => b.cli === cli);
  const installation = snapshot?.installed_inventory?.clis.find((entry) => entry.cli === cli);
  const selected = cliBindings.find((b) => b.native === native) ?? cliBindings.find((b) => b.role === role) ?? cliBindings[0];
  const selectedGroup = groups.find((g) => g.role === (selected?.role ?? role));
  const visibleBindings = cliBindings.filter((b) => `${b.native} ${b.role} ${eventName(b)}`.toLowerCase().includes(search.toLowerCase()));
  const attached = (selected?.handler_ids ?? []).map((id) => snapshot?.handlers.find((h) => h.id === id)).filter((h): h is NonNullable<typeof h> => Boolean(h));
  const cliOptions = [...new Set([...CLI_ORDER, ...bindings.map((b) => b.cli)])];
  const expandedUpdatedAt = history?.items.find((invocation) => invocation.invocation_id === expandedId)?.updated_at;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = ++requestGeneration.current;
    setBusy(true);
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (followSelection) { query.set("cli", cli); if (selected?.native) query.set("native", selected.native); }
    if (handler) query.set("handler", handler);
    if (receiptStatus) query.set("status", receiptStatus);
    const [stateResult, historyResult] = await Promise.allSettled([
      loadJson<HookSnapshot>("/api/modules/hooks/status", signal),
      loadJson<HookHistory>(`/api/modules/hooks/invocations?${query}`, signal),
    ]);
    if (signal?.aborted || generation !== requestGeneration.current) return;
    if (stateResult.status === "fulfilled") { setSnapshot(stateResult.value); setError(null); }
    else setError(stateResult.reason instanceof Error ? stateResult.reason.message : "Hook hub is unavailable.");
    if (historyResult.status === "fulfilled") { setHistory(historyResult.value); setHistoryError(null); }
    else setHistoryError(historyResult.reason instanceof Error ? historyResult.reason.message : "Execution history is unavailable.");
    setBusy(false);
  }, [cli, selected?.native, followSelection, handler, receiptStatus, offset]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    if (paused) return () => controller.abort();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(controller.signal); }, POLL_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [paused, refresh]);

  useEffect(() => {
    if (!expandedId) { setDetail(null); return; }
    const controller = new AbortController();
    setDetail(null); setDetailLoading(true); setDetailError(null);
    void loadJson<{ invocation: HookInvocation }>(`/api/modules/hooks/invocations/${encodeURIComponent(expandedId)}`, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setDetail(value.invocation); })
      .catch((reason) => { if (!controller.signal.aborted) setDetailError(reason instanceof Error ? reason.message : "Receipt unavailable."); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [expandedId, expandedUpdatedAt]);

  function chooseBinding(binding: HookBinding) { setNative(binding.native); setRole(binding.role); setHandler(""); setOffset(0); }
  function chooseRole(nextRole: string) {
    setRole(nextRole); setHandler(""); setOffset(0);
    const binding = cliBindings.find((b) => b.role === nextRole);
    if (binding) setNative(binding.native);
    else {
      const available = bindings.find((b) => b.role === nextRole);
      if (available) { setCli(available.cli); setNative(available.native); }
    }
  }
  function chooseCli(nextCli: string) {
    setCli(nextCli); setOffset(0); setHandler("");
    const binding = bindings.find((b) => b.cli === nextCli && b.role === (selected?.role ?? role)) ?? bindings.find((b) => b.cli === nextCli);
    if (binding) { setNative(binding.native); setRole(binding.role); }
  }

  return <main className="shell hook-shell">
    <header className="topbar"><div><p className="eyebrow">33GOD Control Plane</p><Link className="hook-home" href="/">Holocene</Link></div><div className="hook-live-controls"><span className={`hook-live ${(error || hubIssue) ? "is-offline" : paused ? "is-paused" : ""}`}><i aria-hidden="true" />{error ? "Feed unavailable" : hubIssue ? "Hub needs attention" : paused ? "Paused" : snapshot ? "Live · 4s" : "Connecting"}</span><button type="button" onClick={() => setPaused((v) => !v)}>{paused ? "Resume" : "Pause"}</button><button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? "Refreshing…" : "Refresh"}</button></div></header>
    <nav className="tabs hook-nav" aria-label="Holocene sections"><Link href="/">Fleet</Link><Link href="/?tab=tooling">Tooling</Link><Link href={{ pathname: "/hooks" }} aria-current="page">Hooks</Link><Link href="/?tab=systems">Systems</Link><Link href="/?tab=containers">Containers</Link></nav>
    <div className="hook-heading"><div><h1>Hooks</h1><p>Follow a hook from the CLI to the work it runs.</p></div><div className="hook-overview">{snapshot ? <><span><strong>{new Set(bindings.map((b) => b.cli)).size}</strong> CLI adapters</span><span><strong>{bindings.length}</strong> native bindings</span><span><strong>{snapshot.handlers.filter((h) => h.enabled).length}</strong> handlers</span></> : <span>Connecting to the hook hub…</span>}</div></div>
    {error ? <div className="hook-alert" role="alert"><strong>Live hook data is unavailable.</strong><p>{error}</p>{snapshot ? <p>Showing the last snapshot from {timestamp(snapshot.generated_at, true)}. It may be stale.</p> : null}</div> : null}
    {hubIssue ? <div className="hook-alert" role="alert"><strong>The hub needs attention.</strong><p>{hubIssue}</p></div> : null}
    <div className="hook-cli-bar" aria-label="Select a CLI">{cliOptions.map((id) => {
      const installed = snapshot?.installed_inventory?.clis.find((entry) => entry.cli === id);
      return <button key={id} type="button" aria-pressed={cli === id} className={cli === id ? "is-selected" : ""} onClick={() => chooseCli(id)}>{installed?.status === "drift" ? <span className="hook-cli-issue" title="Installed configuration differs from the canonical hub" aria-label="Wiring needs attention">!</span> : null}{CLI_NAMES[id] ?? id}{snapshot && !bindings.some((b) => b.cli === id) ? <span className="hook-adapter-note">No adapter</span> : installed && !installed.binary_available ? <span className="hook-adapter-note">Not installed</span> : null}</button>;
    })}</div>
    <div className="hook-workspace">
      <aside className="hook-explorer" aria-label="Hook explorer"><label className="hook-search"><span>Find a hook</span><input type="search" value={search} placeholder="Event or native name" onChange={(e) => setSearch(e.target.value)} /></label><div className="hook-explorer-section"><h2>Bloodbank <span>Normalized</span></h2>{groups.filter((g) => `${g.label} ${g.role}`.toLowerCase().includes(search.toLowerCase())).map((g) => <button type="button" key={g.role} aria-pressed={selectedGroup?.role === g.role} onClick={() => chooseRole(g.role)} className={selectedGroup?.role === g.role ? "is-selected" : ""}><span>{g.label}</span><small title={`${g.handlerIds.length} distinct attached handlers across CLIs`}>{g.handlerIds.length}</small></button>)}{!snapshot ? <p className="hook-dim">Event definitions will appear when the hub connects.</p> : null}</div><div className="hook-explorer-section"><h2>{CLI_NAMES[cli] ?? cli} <span>Native hooks</span></h2>{visibleBindings.map((b) => <button type="button" key={b.native} aria-pressed={selected?.native === b.native} onClick={() => chooseBinding(b)} className={selected?.native === b.native ? "is-selected" : ""}><span>{b.native}</span><small className={b.event_type ? "hook-map-mark" : "hook-map-local"} title={b.event_type ? `Normalizes to ${eventName(b)}` : "Local hub signal; no Bloodbank event"}>{b.event_type ? "BB" : "Local"}</small></button>)}{snapshot && !visibleBindings.length ? <p className="hook-dim">{cliBindings.length ? "No hooks match your search." : "No canonical adapter is registered for this CLI."}</p> : null}</div></aside>
      <div className="hook-main">
        <section className="hook-topology" aria-label="Hook topology">
          <div className="hook-panel-heading"><h2>Hook mapping</h2><span>Badges count attached handlers</span></div>
          <div className="hook-tier"><div className="hook-tier-heading"><h3>Bloodbank</h3><span>Normalized events · shared across CLIs</span></div><div className="hook-chips">{groups.map((g) => <button type="button" className={`hook-chip ${selectedGroup?.role === g.role ? "is-selected" : ""}`} key={g.role} aria-pressed={selectedGroup?.role === g.role} onClick={() => chooseRole(g.role)}><span>{g.label}</span><small>{g.handlerIds.length}</small></button>)}</div></div>
          {selected ? <div className="hook-mapping" aria-label="Selected native to normalized mapping"><div><span>{CLI_NAMES[cli] ?? cli} native hook</span><code>{selected.native}</code></div><span className="hook-connector" aria-hidden="true">normalizes to <b>⟶</b></span><div><span>{selected.event_type ? "Bloodbank event" : "Hub lifecycle signal"}</span><code>{eventName(selected)}</code></div><State value={selected.state} /></div> : <div className="hook-empty">{snapshot ? <><h3>No adapter registered</h3><p>{CLI_NAMES[cli] ?? cli} has no canonical native-to-Bloodbank mapping. Its absence is visible here; no successful executions are implied.</p></> : <><h3>Loading hook definitions</h3><p>The hub supplies the current mapping and handler registry.</p></>}</div>}
          <div className="hook-tier"><div className="hook-tier-heading"><h3>{CLI_NAMES[cli] ?? cli}</h3><span>Native hooks · {cliBindings.length} bindings</span></div><div className="hook-chips">{visibleBindings.map((b) => <button type="button" className={`hook-chip ${selected?.native === b.native ? "is-selected" : ""}`} key={b.native} aria-pressed={selected?.native === b.native} onClick={() => chooseBinding(b)}><span>{b.native}</span><span className={b.event_type ? "hook-map-mark" : "hook-map-local"} title={b.event_type ? `Bloodbank: ${eventName(b)}` : "Local hub signal; no Bloodbank event"}>{b.event_type ? "BB" : "Local"}</span><small>{b.handler_ids.length}</small></button>)}</div></div>
          <div className="hook-handlers"><div className="hook-tier-heading"><h3>Attached handlers <span>{attached.length}</span></h3><span>Click a handler to inspect its receipts</span></div><div className="hook-handler-list">{attached.map((h) => {
            const activity = snapshot?.handler_activity.filter((a) => a.handler_id === h.id && a.cli === cli) ?? [];
            const failures = activity.filter((a) => FAILED.has(a.status)).reduce((n, a) => n + a.count, 0);
            return <button key={h.id} type="button" className={`hook-handler ${handler === h.id ? "is-selected" : ""}`} aria-pressed={handler === h.id} onClick={() => { setHandler(handler === h.id ? "" : h.id); setOffset(0); }}><strong>{handlerName(h.id)}</strong><span>{!h.enabled ? "Paused in registry" : h.mode === "sync" ? "Before CLI continues" : "Background"}</span><span className="hook-handler-meta">{durationLabel(h.timeout_ms)} limit{failures ? <b>{failures} {failures === 1 ? "issue" : "issues"}</b> : <span>{activity.reduce((n, a) => n + a.count, 0)} receipts</span>}</span></button>;
          })}</div>{selected && !attached.length ? <p className="hook-dim">No executable handlers are attached to this binding.</p> : null}{selected ? <p className="hook-topology-note">{selected.activity ? <>Last received {timestamp(selected.activity.last_received_at, true)} · {selected.activity.invocations} invocations since {timestamp(snapshot?.observed_since, true)}.</> : "Configured mapping; no invocation has been observed in the receipt journal yet."} {selected.event_type ? <code>{selected.event_type}</code> : " This native signal runs locally; it has no Bloodbank event contract."}</p> : null}</div>
        </section>
        <details className="hook-wiring" key={`wiring-${cli}`} open={installation?.status === "drift"}>
          <summary><span>Installed wiring <strong>{CLI_NAMES[cli] ?? cli}</strong></span><span>{installation ? <><State value={installation.status} /><span>{installation.configs.length} config {installation.configs.length === 1 ? "source" : "sources"}</span></> : "Inventory unavailable"}</span></summary>
          <div className="hook-wiring-body">
            {installation ? <><p className="hook-wiring-note">Each source should invoke the hub once per native hook. Direct managed calls can run the same work twice.{!installation.binary_available ? " The CLI executable was not found on this host." : ""}</p>
              <div className="hook-table-scroll"><table className="hook-wiring-table"><thead><tr><th>Native hook</th><th>Hub calls / expected</th><th>Direct calls</th><th>Configuration</th></tr></thead><tbody>{installation.natives.map((entry) => <tr key={entry.native}><td><button type="button" className="hook-wiring-event" onClick={() => { const binding = cliBindings.find((b) => b.native === entry.native); if (binding) chooseBinding(binding); }}>{entry.native}</button></td><td className="hook-mono">{entry.actual_hub_count} / {entry.expected_count}</td><td className={entry.direct_managed_count ? "hook-inline-bad hook-mono" : "hook-mono"}>{entry.direct_managed_count}</td><td><State value={entry.status} /></td></tr>)}</tbody></table></div>
              <details className="hook-sources"><summary>Configuration sources and findings</summary><ul>{installation.configs.map((config) => <li key={config.source}><div><span>{config.label}</span><State value={config.status} /></div><code>{config.source}</code>{config.errors.map((issue) => <p key={issue} className="hook-inline-bad">{issue}</p>)}</li>)}</ul>{installation.natives.flatMap((entry) => entry.sources.flatMap((source) => source.issues.map((issue) => <p className="hook-source-issue" key={`${entry.native}-${source.source}-${issue}`}><strong>{entry.native}</strong> · {issue}<code>{source.source}</code></p>)))}</details>
              <p className="hook-wiring-note">Trust check: {installation.trust_verification === "native_probe_required" ? "Configuration inspected; CLI loader verification is a separate check." : (installation.trust_verification ?? (installation.status === "unsupported" ? "Not applicable" : "Not verified")).replaceAll("_", " ")} · Inspected {timestamp(snapshot?.installed_inventory?.generated_at, true)}</p>
            </> : <p className="hook-wiring-note">The installed configuration could not be inspected. Registry definitions alone do not prove that the CLI is wired to the hub.</p>}
          </div>
        </details>
        <section className="hook-history" aria-label="Invocation history"><div className="hook-panel-heading"><div><h2>Execution receipts</h2><span>{history ? `${history.total.toLocaleString()} matching invocations` : "Loading history"}{snapshot?.observed_since ? ` · journal since ${timestamp(snapshot.observed_since, true)}` : ""}</span></div><label className="hook-check"><input type="checkbox" checked={followSelection} onChange={(e) => { setFollowSelection(e.target.checked); setOffset(0); }} />Follow selection</label></div><div className="hook-history-controls"><label>Outcome<select value={receiptStatus} onChange={(e) => { setReceiptStatus(e.target.value); setOffset(0); }}><option value="">All outcomes</option>{["succeeded", "failed", "timed_out", "interrupted", "skipped", "started", "deduplicated"].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></label>{handler ? <button type="button" className="hook-filter-clear" onClick={() => { setHandler(""); setOffset(0); }}>{handlerName(handler)} <span aria-hidden="true">×</span><span className="hook-sr-only">Clear handler filter</span></button> : null}<span>{followSelection ? `${CLI_NAMES[cli] ?? cli} · ${selected?.native ?? "all hooks"}` : "All CLIs and native hooks"}</span></div>
          {historyError ? <p className="hook-inline-error" role="alert">{historyError} {history ? "The rows below are from the last successful refresh." : ""}</p> : null}
          <div className="hook-table-scroll"><table className="hook-history-table"><thead><tr><th>Received</th><th>CLI</th><th>Native hook</th><th>Handlers</th><th>Outcome</th><th>Duration</th><th><span className="hook-sr-only">Receipt</span></th></tr></thead><tbody>{history?.items.map((invocation) => <Fragment key={invocation.invocation_id}><tr className={expandedId === invocation.invocation_id ? "is-expanded" : ""}><td className="hook-mono"><time dateTime={invocation.received_at} title={timestamp(invocation.received_at, true)}>{timestamp(invocation.received_at)}</time></td><td>{CLI_NAMES[invocation.cli] ?? invocation.cli}</td><td><code>{invocation.native}</code></td><td className="hook-mono">{invocation.executions.filter((e) => e.status === "succeeded").length}<span className="hook-dim">/{invocation.executions.length}</span></td><td><State value={invocation.status} />{invocation.deduplicated ? <span className="hook-dedup" title="Repeated deliveries suppressed">↪ {invocation.deduplicated}</span> : null}</td><td className="hook-mono">{durationLabel(invocationDuration(invocation))}</td><td><button type="button" className="hook-view-receipt" aria-expanded={expandedId === invocation.invocation_id} aria-controls={`receipt-${invocation.invocation_id}`} onClick={() => setExpandedId(expandedId === invocation.invocation_id ? null : invocation.invocation_id)}>{expandedId === invocation.invocation_id ? "Close" : "Inspect"}<span className="hook-sr-only"> receipt for {invocation.native} at {timestamp(invocation.received_at)}</span></button></td></tr>{expandedId === invocation.invocation_id ? <tr><td colSpan={7} id={`receipt-${invocation.invocation_id}`} className="hook-receipt-cell">{detailError ? <p className="hook-inline-error" role="alert">{detailError}</p> : null}<Receipt invocation={detail?.invocation_id === invocation.invocation_id ? detail : invocation} loading={detailLoading} /></td></tr> : null}</Fragment>)}</tbody></table></div>
          {!history?.items.length ? <div className="hook-empty"><h3>{historyError ? "History unavailable" : history ? "No matching invocations" : "Loading execution history"}</h3><p>{history ? "A configured hook can be quiet. Its first invocation will appear here with the work it actually ran." : "Execution results will appear after the hook hub responds."}</p></div> : null}
          <div className="hook-history-footer"><span>{history?.total ? `${offset + 1}–${offset + history.items.length} of ${history.total}` : "0 receipts"} · Handler counts show succeeded / selected</span><div><button type="button" disabled={offset === 0 || busy} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Newer</button><button type="button" disabled={history?.next_offset == null || busy} onClick={() => setOffset(history?.next_offset ?? offset)}>Older</button></div></div>
        </section>
      </div>
    </div>
    <footer className="hook-page-footer"><span>Canonical hook hub{snapshot ? ` · PID ${snapshot.hub.pid} · ${snapshot.hub.async_running} background handlers running` : ""}</span><span>{snapshot ? `Updated ${timestamp(snapshot.generated_at, true)}` : "Awaiting first snapshot"}</span></footer>
  </main>;
}

"use client";

import { useEffect, useState } from "react";

// Read-only view of the DeLoNET Director (HOLOC-8). The browser only ever talks to holocene-api; the Director's own
// API is loopback-only. Nothing on this tab mutates anything.

type Severity = "error" | "warning" | "info";
type HealthLevel = "ok" | "degraded" | "down";

type TargetPm = {
  agent_id: string;
  resolved: boolean;
  display_name: string;
  repo: string | null;
  role: string | null;
};

type Delegation = {
  state: "active" | "queued";
  correlation_id: string;
  kind: string;
  slot_id: string | null;
  borrowed: boolean | null;
  since: string | null;
  expires_at: string | null;
  ttl_seconds: number | null;
  ticket: string | null;
  owner: string | null;
  outcome: string | null;
  targetPm: TargetPm | null;
};

type Lane = {
  id: string;
  preferred_kind: string;
  state: "free" | "live" | "expired" | "malformed";
  allocation: {
    correlation_id: string;
    kind: string;
    borrowed: boolean;
    allocated_at: string | null;
    expires_at: string | null;
    expires_in_s: number | null;
    live: boolean;
    ticket: string | null;
    owner: string | null;
    outcome: string | null;
    targetPm: TargetPm | null;
  } | null;
};

type DirectorSnapshot = {
  generatedAt: string;
  health: {
    level: HealthLevel;
    reasons: string[];
    refused: boolean;
    mode: string | null;
    process: "up" | "unavailable";
    capacity_database_present: boolean | null;
    contract_database_present: boolean | null;
    canonical_ready: boolean | null;
    canonical_head: string | null;
    readiness: string | null;
  };
  lanes: {
    available: boolean;
    capacity_total: number | null;
    counts: Record<string, number> | null;
    needs_reconciliation: boolean | null;
    items: Lane[];
  };
  delegations: {
    available: boolean;
    fleetRegistryAvailable: boolean;
    active: Delegation[];
    queued: Delegation[];
  };
  readiness: {
    available: boolean;
    label: string | null;
    counts: Record<string, number> | null;
    findings: { code: string; severity: string; message: string }[];
    projects: { slug: string; readiness: string; reason_codes: string[] }[];
    reason_codes: string[];
  };
  receipts: {
    work: {
      available: boolean;
      items: {
        id: string;
        correlation_id: string;
        terminal_status: string;
        work_id: string | null;
        delegation_id: string | null;
        project: string | null;
        summary: string | null;
        at: string | null;
      }[];
      note: string | null;
    };
    leases: {
      available: boolean;
      items: { id: number; correlation_id: string; action: string; outcome: string; slot_id: string | null; at: string | null }[];
      note: string | null;
    };
  };
  exceptions: { severity: Severity; code: string; message: string; source: string }[];
  sources: { name: string; path: string; ok: boolean; status: number | null; ms: number; error?: string }[];
};

const REFRESH_MS = 15_000;

function span(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

function rel(iso: string | null, now: number): string {
  if (!iso) return "unknown";
  const diff = (Date.parse(iso) - now) / 1000;
  return diff >= 0 ? `in ${span(diff)}` : `${span(diff)} ago`;
}

function present(value: boolean | null): string {
  return value === null ? "unknown" : value ? "present" : "missing";
}

function PmChip({ pm }: { pm: TargetPm | null }) {
  if (!pm) return <span className="dir-pm dir-pm-none">no target PM named</span>;
  if (!pm.resolved) {
    return (
      <span className="dir-pm dir-pm-unresolved" title="Not in Holocene's fleet registry">
        {pm.agent_id} <em>unresolved</em>
      </span>
    );
  }
  return (
    <span className="dir-pm" title={pm.repo ?? undefined}>
      {pm.display_name}
      {pm.role ? <em>{pm.role}</em> : null}
    </span>
  );
}

function DelegationRow({ d, now }: { d: Delegation; now: number }) {
  return (
    <li className="dir-row">
      <div className="dir-row-main">
        <strong>{d.ticket ?? d.correlation_id}</strong>
        <span className="dir-tag">{d.state === "queued" ? "queued" : d.slot_id}</span>
        {d.borrowed ? <span className="dir-tag">borrowed</span> : null}
      </div>
      {d.outcome ? <div className="dir-outcome">{d.outcome}</div> : null}
      <div className="dir-row-meta">
        <PmChip pm={d.targetPm} />
        {d.state === "active" ? (
          <small>expires {rel(d.expires_at, now)}</small>
        ) : (
          <small>
            requested {rel(d.since, now)}
            {d.ttl_seconds !== null ? ` · ttl ${span(d.ttl_seconds)}` : ""}
          </small>
        )}
        <small className="dir-corr">{d.correlation_id}</small>
      </div>
    </li>
  );
}

export default function DirectorTab({ apiBase }: { apiBase: string }) {
  const [snapshot, setSnapshot] = useState<DirectorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/api/modules/director/snapshot`, { cache: "no-store" });
        if (!response.ok) throw new Error(`snapshot ${response.status}`);
        const data = (await response.json()) as DirectorSnapshot;
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
          setNow(Date.now());
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "snapshot unavailable");
      }
    };

    void load();
    const interval = window.setInterval(() => {
      void load();
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [apiBase]);

  const level = snapshot?.health.level;
  const down = level === "down";
  // Hide the sections only when nothing can be trusted: a refused mode, or no source answering at all. A healthz-only
  // failure still leaves the other sources, which carry their own available flags.
  const allSourcesDown = snapshot ? snapshot.sources.every((s) => !s.ok) : false;
  const hideSections = snapshot ? snapshot.health.refused || allSourcesDown : false;
  const stale = Boolean(error && snapshot);
  const bannerTitle = !snapshot
    ? ""
    : stale
      ? "Holocene API unreachable, showing the last good snapshot"
      : snapshot.health.refused
        ? "Director refused: not read-only"
        : allSourcesDown
          ? "Director unavailable"
          : down
            ? "Director health unconfirmed (healthz did not answer)"
            : level === "degraded"
              ? "Director degraded"
              : "Director healthy";

  return (
    <section className="tooling-section" aria-label="Director">
      <div className="section-heading">
        <div>
          <h2>Director</h2>
          <p className="section-note">
            DeLoNET Director portfolio state, read-only. Holocene reads it server-side and cannot change it.
          </p>
        </div>
        {snapshot ? <span>{new Date(snapshot.generatedAt).toLocaleTimeString()}</span> : null}
      </div>

      {error ? (
        <div className="empty">
          Holocene API could not produce the Director snapshot: {error}
          {snapshot ? " (showing the last good snapshot below)" : ""}
        </div>
      ) : null}
      {!error && !snapshot ? <div className="empty">Loading Director state...</div> : null}

      {snapshot ? (
        <>
          <div
            className={`dir-banner dir-level-${snapshot.health.level}${stale ? " dir-stale" : ""}`}
            role={down || stale ? "alert" : "status"}
          >
            <div className="dir-banner-head">
              <strong>{bannerTitle}</strong>
              <span className="dir-level-pill">{stale ? `stale since ${new Date(snapshot.generatedAt).toLocaleTimeString()}` : snapshot.health.level}</span>
            </div>
            {snapshot.health.reasons.length ? (
              <ul className="dir-reasons">
                {snapshot.health.reasons.map((reason, i) => (
                  <li key={`${i}-${reason}`}>{reason}</li>
                ))}
              </ul>
            ) : (
              <span className="section-note">Every source answered and nothing needs attention.</span>
            )}
            <div className="dir-facts">
              <span>process: {snapshot.health.process}</span>
              <span>mode: {snapshot.health.mode ?? "unknown"}</span>
              <span>readiness: {snapshot.health.readiness ?? "unknown"}</span>
              <span>capacity db: {present(snapshot.health.capacity_database_present)}</span>
              <span>contract db: {present(snapshot.health.contract_database_present)}</span>
              <span>
                contracts:{" "}
                {snapshot.health.canonical_ready === null
                  ? "unknown"
                  : snapshot.health.canonical_ready
                    ? `ready${snapshot.health.canonical_head ? ` @ ${snapshot.health.canonical_head.slice(0, 7)}` : ""}`
                    : "not ready"}
              </span>
            </div>
          </div>

          <div className="dir-block">
            <h3>Exceptions ({snapshot.exceptions.length})</h3>
            {snapshot.exceptions.length ? (
              <ul className="dir-exceptions">
                {snapshot.exceptions.map((ex, i) => (
                  <li className={`dir-exception dir-sev-${ex.severity}`} key={`${ex.code}-${i}`}>
                    <span className="dir-sev">{ex.severity}</span>
                    <div>
                      <strong>{ex.code}</strong>
                      <span>{ex.message}</span>
                    </div>
                    <small>{ex.source}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="section-note">No exceptions.</p>
            )}
          </div>

          {hideSections ? (
            <div className="empty">
              {snapshot.health.refused
                ? "The Director reports a mode other than read-only, so Holocene is not rendering its state."
                : "Lanes, delegations, readiness and receipts are hidden because the Director did not answer. Nothing here should be read as idle or healthy."}
            </div>
          ) : (
            <>
              <div className="dir-block">
                <h3>
                  Capacity lanes
                  {snapshot.lanes.counts ? (
                    <small>
                      {" "}
                      {snapshot.lanes.counts.active ?? 0} active · {snapshot.lanes.counts.queued ?? 0} queued ·{" "}
                      {snapshot.lanes.counts.released ?? 0} released · {snapshot.lanes.counts.expired ?? 0} expired (lifetime)
                    </small>
                  ) : null}
                </h3>
                {snapshot.lanes.available ? (
                  <div className="dir-lanes">
                    {snapshot.lanes.items.map((lane, i) => (
                      <div className={`dir-lane dir-lane-${lane.state}`} key={`${lane.id}-${i}`}>
                        <div className="dir-lane-head">
                          <strong>{lane.id}</strong>
                          <span className="dir-tag">
                            {lane.state === "free"
                              ? "free"
                              : lane.state === "live"
                                ? "live"
                                : lane.state === "malformed"
                                  ? "malformed, no expires_at"
                                  : "expired, still active"}
                          </span>
                        </div>
                        <small>prefers {lane.preferred_kind}</small>
                        {lane.allocation ? (
                          <>
                            <div className="dir-outcome">{lane.allocation.outcome ?? lane.allocation.correlation_id}</div>
                            <PmChip pm={lane.allocation.targetPm} />
                            <small>
                              {lane.allocation.ticket ? `${lane.allocation.ticket} · ` : ""}
                              {lane.allocation.live ? "expires" : "expired"} {rel(lane.allocation.expires_at, now)}
                            </small>
                            <small className="dir-corr">{lane.allocation.correlation_id}</small>
                          </>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty">Capacity state is unknown: the Director did not confirm its capacity database. Nothing here should be read as idle.</div>
                )}
              </div>

              <div className="dir-block">
                <h3>Delegations</h3>
                {snapshot.delegations.available ? (
                  <div className="dir-columns">
                    <div className="dir-panel">
                      <h4>Active ({snapshot.delegations.active.length})</h4>
                      {snapshot.delegations.active.length ? (
                        <ul className="dir-list">
                          {snapshot.delegations.active.map((d, i) => (
                            <DelegationRow d={d} now={now} key={`${d.correlation_id}-${i}`} />
                          ))}
                        </ul>
                      ) : (
                        <p className="section-note">No live leases.</p>
                      )}
                    </div>
                    <div className="dir-panel">
                      <h4>Queued ({snapshot.delegations.queued.length})</h4>
                      {snapshot.delegations.queued.length ? (
                        <ul className="dir-list">
                          {snapshot.delegations.queued.map((d, i) => (
                            <DelegationRow d={d} now={now} key={`${d.correlation_id}-${i}`} />
                          ))}
                        </ul>
                      ) : (
                        <p className="section-note">Queue is empty.</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="empty">Capacity state is unknown; delegations cannot be listed.</div>
                )}
                {!snapshot.delegations.fleetRegistryAvailable ? (
                  <p className="section-note">Fleet registry unreadable, so no target PM could be resolved.</p>
                ) : null}
              </div>

              <div className="dir-block">
                <h3>Readiness</h3>
                {snapshot.readiness.available ? (
                  <>
                    <div className="dir-readiness-head">
                      <span className={`dir-pill dir-pill-${snapshot.readiness.label ?? "unknown"}`}>
                        {snapshot.readiness.label ?? "unknown"}
                      </span>
                      {snapshot.readiness.counts ? (
                        <small>
                          {snapshot.readiness.counts.projects_total ?? 0} projects · {snapshot.readiness.counts.global_error ?? 0} errors ·{" "}
                          {snapshot.readiness.counts.global_warning ?? 0} warnings · {snapshot.readiness.counts.global_info ?? 0} info
                        </small>
                      ) : null}
                    </div>
                    {snapshot.readiness.findings.length ? (
                      <ul className="dir-list dir-findings">
                        {snapshot.readiness.findings.map((f, i) => (
                          <li className={`dir-finding dir-sev-${f.severity}`} key={`${f.code}-${i}`}>
                            <span className="dir-sev">{f.severity}</span>
                            <div>
                              <strong>{f.code}</strong>
                              <span>{f.message}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {snapshot.readiness.projects.length ? (
                      <ul className="dir-list">
                        {snapshot.readiness.projects.map((p) => (
                          <li className="dir-row" key={p.slug}>
                            <div className="dir-row-main">
                              <strong>{p.slug}</strong>
                              <span className={`dir-pill dir-pill-${p.readiness}`}>{p.readiness}</span>
                            </div>
                            {p.reason_codes.length ? <small className="dir-corr">{p.reason_codes.join(", ")}</small> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="section-note">The Director lists no projects.</p>
                    )}
                  </>
                ) : (
                  <div className="empty">Readiness source unavailable.</div>
                )}
              </div>

              <div className="dir-block">
                <h3>Terminal receipts</h3>
                <div className="dir-columns">
                  <div className="dir-panel">
                    <h4>Work outcomes</h4>
                    {!snapshot.receipts.work.available ? (
                      <p className="section-note">Contract receipts source unavailable.</p>
                    ) : snapshot.receipts.work.items.length ? (
                      <ul className="dir-list">
                        {snapshot.receipts.work.items.map((r) => (
                          <li className="dir-row" key={r.id}>
                            <div className="dir-row-main">
                              <strong>{r.project ?? r.work_id ?? r.correlation_id}</strong>
                              <span className={`dir-pill dir-pill-${r.terminal_status}`}>{r.terminal_status}</span>
                            </div>
                            {r.summary ? <div className="dir-outcome">{r.summary}</div> : null}
                            <small>{rel(r.at, now)}</small>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {snapshot.receipts.work.note ? <p className="section-note">{snapshot.receipts.work.note}</p> : null}
                  </div>
                  <div className="dir-panel">
                    <h4>Lease ends</h4>
                    {!snapshot.receipts.leases.available ? (
                      <p className="section-note">
                        {snapshot.receipts.leases.note ?? "Capacity receipts source unavailable."}
                      </p>
                    ) : snapshot.receipts.leases.items.length ? (
                      <ul className="dir-list">
                        {snapshot.receipts.leases.items.map((r) => (
                          <li className="dir-row" key={r.id}>
                            <div className="dir-row-main">
                              <strong>{r.correlation_id}</strong>
                              <span className="dir-tag">{r.action}</span>
                            </div>
                            <small>
                              {r.slot_id ? `${r.slot_id} · ` : ""}
                              {rel(r.at, now)}
                            </small>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="section-note">No lease has ended.</p>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          <div className="dir-sources" aria-label="Director sources">
            {snapshot.sources.map((s) => (
              <span
                className={s.ok ? "dir-source dir-source-ok" : "dir-source dir-source-bad"}
                key={s.name}
                title={s.error ?? s.path}
              >
                {s.name} {s.ok ? "ok" : (s.status ?? "down")} · {s.ms}ms
              </span>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

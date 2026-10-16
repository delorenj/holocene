"use client";

import { Brand, ThemeToggle, usePoll, useTheme } from "../hub/hub-app";
import { CopyRef, SourceStrip, sinceSeconds, formatDuration } from "../hub/ui";
import type { Source } from "../hub/types";
import { PipelineGraph } from "./pipeline-graph";
import type { WaxPass, WaxPayload, WaxPipeline, WaxPipelineNode, WaxWorkerStatus } from "./types";

// The Wax tab: what the enrichment system IS, read from the one safe discovery
// snapshot (`wax catalog --json` via the Holocene API). Read-only by design —
// enabling a pass, compiling a pipeline or running one belongs to the Wax CLI
// and n8n, never to this surface.

const POLL_MS = 10_000;

const AVAILABILITY_WORD: Record<string, string> = {
  available: "available", disabled: "disabled", placeholder: "placeholder",
  quarantined: "quarantined", unparseable: "unparseable"
};

const OUTCOME_ORDER = ["completed", "failed", "skipped", "running", "exhausted", "stale"] as const;

function statement(d: WaxPayload): string {
  const c = d.catalog.counts ?? {};
  const passes = d.catalog.passes ?? [];
  const pipelines = d.catalog.pipelines ?? [];
  if (d.source.down) return `The Wax CLI is not answering — showing ${d.catalog.passes?.length ? "the last good read" : "no catalog"}.`;
  const parts: string[] = [];
  parts.push(`${c.registered ?? passes.length} passes registered, ${c.enabled ?? 0} enabled, ${c.automatic ?? 0} automatic.`);
  if (c.failing) parts.push(`${c.failing} pass${c.failing === 1 ? "" : "es"} with failed outcomes.`);
  if (c.quarantined) parts.push(`${c.quarantined} quarantined.`);
  const drifted = pipelines.filter((p) => p.drift?.state && p.drift.state !== "in-sync");
  if (!pipelines.length) parts.push("No pipelines are authored yet.");
  else parts.push(`${pipelines.length} pipeline${pipelines.length === 1 ? "" : "s"}, ${drifted.length} with drift.`);
  return parts.join(" ");
}

function AvailabilityBadge({ state, reason }: { state: string; reason?: string }) {
  const word = AVAILABILITY_WORD[state] ?? state;
  return (
    <span className={`wax-badge is-${state}`} title={reason || word}>
      {word}
    </span>
  );
}

function Chips({ items, className }: { items: string[]; className: string }) {
  if (!items.length) return null;
  return (
    <span className={className}>
      {items.map((item) => (
        <span key={item} className="wax-chip">{item}</span>
      ))}
    </span>
  );
}

function Outcomes({ outcomes }: { outcomes?: Record<string, number> }) {
  if (!outcomes) return null;
  const rows = OUTCOME_ORDER.filter((k) => outcomes[k] !== undefined && outcomes[k] !== 0);
  if (!rows.length) return <span className="wax-outcomes wax-outcomes-empty">no recorded outcomes</span>;
  return (
    <span className="wax-outcomes">
      {rows.map((k) => (
        <span key={k} className={`wax-outcome is-${k}`}>
          {outcomes[k]} {k}
        </span>
      ))}
    </span>
  );
}

function PassCard({ pass }: { pass: WaxPass }) {
  const conditions = pass.conditions ?? undefined;
  return (
    <article className="wax-card wax-pass">
      <header className="wax-card-head">
        <h3 className="wax-slug">{pass.slug}</h3>
        <AvailabilityBadge state={pass.availability.state} reason={pass.availability.reason} />
      </header>
      {pass.description ? <p className="wax-desc">{pass.description}</p> : null}
      <div className="wax-meta">
        <Chips items={pass.capabilities ?? []} className="wax-caps" />
        <span className="wax-flags">
          {pass.enabled ? <span className="wax-flag is-on">enabled</span> : <span className="wax-flag">enabled: no</span>}
          {pass.auto ? <span className="wax-flag is-auto">automatic</span> : null}
          {pass.version ? <span className="wax-flag">v{pass.version}</span> : null}
          {pass.kind ? <span className="wax-flag">{pass.kind}</span> : null}
        </span>
      </div>
      {pass.requires?.length || pass.after?.length ? (
        <p className="wax-edges">
          {pass.requires?.length ? <span>requires {pass.requires.join(", ")}</span> : null}
          {pass.after?.length ? <span>after {pass.after.join(", ")}</span> : null}
        </p>
      ) : null}
      {conditions?.when ? <p className="wax-cond">when {JSON.stringify(conditions.when)}</p> : null}
      {conditions?.skip_when ? <p className="wax-cond">skip when {JSON.stringify(conditions.skip_when)}</p> : null}
      {pass.emits?.length ? (
        <p className="wax-emits">
          {pass.emits.map((event) => <code key={event} className="hub-code">{event}</code>)}
        </p>
      ) : null}
      <footer className="wax-card-foot">
        <Outcomes outcomes={pass.outcomes} />
      </footer>
    </article>
  );
}

function WorkerStrip({ worker }: { worker?: WaxWorkerStatus }) {
  if (!worker) return null;
  const live = worker.state === "live";
  const idle = live && worker.pipeline_enabled === false;
  const state = !live ? "down" : idle ? "idle" : "live";
  const label = !live
    ? `worker down — ${worker.note ?? "no heartbeat"}`
    : idle
      ? "worker live · pipeline disabled (healthy idle — nobody scans)"
      : `worker live · document scan every ${worker.documents?.interval_s ?? "?"}s · heartbeat ${worker.age_seconds ?? "?"}s ago`;
  return (
    <p className={`wax-worker is-${state}`} title={worker.note ?? undefined}>
      <span className={`wax-worker-dot is-${state}`} aria-hidden="true" />
      {label}
      {worker.documents?.scanning && live && !idle ? " · scanning" : ""}
    </p>
  );
}

function RecentRuns({ pipeline }: { pipeline: WaxPipeline }) {
  const runs = pipeline.recent_runs ?? [];
  if (!runs.length) return null;
  return (
    <section className="wax-section">
      <h4>Recent runs <span className="wax-section-note">(last {runs.length}, durable receipts)</span></h4>
      <table className="wax-runs">
        <thead>
          <tr><th>document</th><th>state</th><th>attempts</th><th>last attempt</th><th>error</th></tr>
        </thead>
        <tbody>
          {runs.map((run, i) => (
            <tr key={`${run.doc_id}-${i}`} className={run.state === "completed" ? "" : "is-bad"}>
              <td><code className="hub-code">{(run.doc_id ?? "?").slice(0, 20)}</code></td>
              <td>
                <span className={`wax-run-state is-${run.state ?? "unknown"}`}>
                  {run.state ?? "unknown"}{run.exhausted_at ? " · exhausted" : ""}
                </span>
              </td>
              <td>{run.attempts ?? 0}</td>
              <td>{run.last_attempt_at ? `${formatDuration(Math.max(0, (Date.now() - Date.parse(run.last_attempt_at)) / 1000))} ago` : "—"}</td>
              <td className="wax-run-error" title={run.error ?? undefined}>{run.error ? run.error.slice(0, 60) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function PipelineCard({ pipeline }: { pipeline: WaxPipeline }) {
  const drift = pipeline.drift?.state ?? "unknown";
  const drifted = drift !== "in-sync";
  return (
    <article className="wax-card wax-pipeline">
      <header className="wax-card-head">
        <h3 className="wax-slug">{pipeline.name}</h3>
        <span className={`wax-drift${drifted ? " is-drifted" : ""}`} title={pipeline.drift?.detail || drift}>
          {drift}
        </span>
      </header>
      {pipeline.description ? <p className="wax-desc">{pipeline.description}</p> : null}
      {pipeline.authored_error ? <p className="hub-error">{pipeline.authored_error}</p> : null}
      <div className="wax-meta">
        <span className="wax-flags">
          {pipeline.trigger ? <span className="wax-flag">{pipeline.trigger}</span> : null}
          {pipeline.enabled ? <span className="wax-flag is-on">enabled</span> : <span className="wax-flag">disabled</span>}
          {pipeline.failure_policy ? <span className="wax-flag">{pipeline.failure_policy}</span> : null}
          {pipeline.version ? <span className="wax-flag">v{pipeline.version}</span> : null}
        </span>
      </div>
      {pipeline.executed_by ? (
        <p className="wax-executed">executed by <code className="hub-code">{pipeline.executed_by}</code></p>
      ) : null}
      {pipeline.definition_id ? (
        <p className="wax-defid">
          <CopyRef value={pipeline.definition_id} label={pipeline.definition_id.slice(0, 12)} />
          {pipeline.compiled_at ? <span className="hub-age"> compiled {formatDuration(Math.max(0, (Date.now() - Date.parse(pipeline.compiled_at)) / 1000))} ago</span> : null}
          {pipeline.source === "n8n" && pipeline.source_ref ? <span className="hub-age"> · authored in n8n “{pipeline.source_ref}”</span> : null}
        </p>
      ) : null}
      {pipeline.registry_drift?.count ? (
        <p className="wax-registry-drift">
          {pipeline.registry_drift.count} node{pipeline.registry_drift.count === 1 ? "" : "s"} differ from the live registry — the frozen definition executes until an explicit recompile.
        </p>
      ) : null}
      {pipeline.nodes?.length ? (
        <section className="wax-section">
          <h4>Graph <span className="wax-section-note">(frozen compiled definition)</span></h4>
          <PipelineGraph pipeline={pipeline} />
        </section>
      ) : null}
      {pipeline.bindings?.length ? (
        <section className="wax-section">
          <h4>Folder bindings</h4>
          <ul className="wax-bindings">
            {pipeline.bindings.map((binding, i) => (
              <li key={binding.binding_id ?? i} className={binding.enabled ? "" : "is-off"}>
                <code className="hub-code">{binding.folder}</code>
                <span className="wax-binding-flags">
                  {binding.enabled ? "enabled" : "disabled"}
                  {binding.folder_exists === false ? " · folder missing" : ""}
                  {binding.documents !== undefined ? ` · ${binding.documents} documents` : ""}
                  {binding.documents_unprocessed ? ` · ${binding.documents_unprocessed} unprocessed` : ""}
                  {binding.documents_failed ? ` · ${binding.documents_failed} failed` : ""}
                  {binding.documents_exhausted ? ` · ${binding.documents_exhausted} exhausted` : ""}
                  {binding.last_scan_at ? ` · scanned ${formatDuration(Math.max(0, (Date.now() - Date.parse(binding.last_scan_at)) / 1000))} ago` : " · never scanned"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <RecentRuns pipeline={pipeline} />
      <footer className="wax-card-foot">
        <Outcomes outcomes={pipeline.outcomes ? Object.values(pipeline.outcomes)[0] : undefined} />
        {pipeline.documents_processed !== undefined ? (
          <span className="wax-count">{pipeline.documents_processed} documents processed</span>
        ) : null}
      </footer>
    </article>
  );
}

export function WaxApp() {
  const [theme, toggleTheme] = useTheme();
  const list = usePoll<WaxPayload>("/api/modules/wax/catalog", POLL_MS);
  const sources: Source[] = list.data
    ? [{ name: list.data.source.name, value: list.data.source.value, down: list.data.source.down, detail: list.data.source.detail, ageSeconds: sinceSeconds(list.data.generated_at, Date.now()) }]
    : [];
  const passes = list.data?.catalog.passes ?? [];
  const pipelines = list.data?.catalog.pipelines ?? [];

  return (
    <div className="hub-root" data-theme={theme}>
      <header className="hub-header">
        <Brand />
        <nav className="hub-tabs" aria-label="Views">
          <a className="hub-tab" href="/?view=agents">Agents</a>
          <a className="hub-tab" href="/?view=projects">Projects</a>
          <a className="hub-tab" href="/voice">Voice</a>
          <a className="hub-tab" href="/wax" aria-current="page">Wax</a>
        </nav>
        <div className="hub-header-end">
          <SourceStrip sources={sources} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="hub-body">
        <div className="hub-lede">
          <p className="hub-statement" aria-live="polite">
            {list.data ? statement(list.data) : list.error ? "The Holocene API is not answering." : "Reading the Wax catalog…"}
          </p>
          {list.error ? (
            <p className="hub-error" role="status">
              <span className="hub-label">API</span>
              {list.data ? `Showing the last good read. ${list.error}` : list.error}
            </p>
          ) : null}
        </div>

        <p className="wax-readonly">
          Read-only view. Enabling a pass, compiling a pipeline or running one happens in the Wax CLI
          (<code className="hub-code">wax ep · wax pipeline · wax documents</code>) or n8n — never here.
        </p>

        <WorkerStrip worker={list.data?.catalog.worker} />

        {list.data && !passes.length && !pipelines.length && !list.data.source.down ? (
          <div className="hub-placeholder">
            <span className="hub-label">Empty catalog</span>
            <p>Wax answered with no registered passes. Check the pass registry under config/passes.d.</p>
          </div>
        ) : null}

        <section aria-label="Enrichment passes">
          <h2 className="wax-heading">Passes</h2>
          <div className="wax-grid">
            {passes.map((pass) => <PassCard key={pass.slug} pass={pass} />)}
          </div>
        </section>

        <section aria-label="Pipelines">
          <h2 className="wax-heading">Pipelines</h2>
          <div className="wax-grid">
            {pipelines.map((pipeline) => <PipelineCard key={pipeline.name} pipeline={pipeline} />)}
          </div>
        </section>
      </div>
    </div>
  );
}

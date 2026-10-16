"use client";

import { Brand, ThemeToggle, usePoll, useTheme } from "../hub/hub-app";
import { CopyRef, SourceStrip, sinceSeconds, formatDuration } from "../hub/ui";
import type { Source } from "../hub/types";
import type { WaxPass, WaxPayload, WaxPipeline, WaxPipelineNode } from "./types";

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

function PipelineNode({ node }: { node: WaxPipelineNode }) {
  return (
    <li className={`wax-node${node.applicable === false ? " is-na" : ""}`}>
      <span className="wax-node-slug">{node.slug}</span>
      {node.applicable === false
        ? <span className="wax-node-na" title="the pass declares no document capability, so document runs skip it">n/a for documents</span>
        : node.availability?.state
          ? <AvailabilityBadge state={node.availability.state} reason={node.availability.reason} />
          : null}
    </li>
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
        </p>
      ) : null}
      {pipeline.nodes?.length ? (
        <section className="wax-section">
          <h4>Nodes</h4>
          <ul className="wax-nodes">
            {pipeline.nodes.map((node) => <PipelineNode key={node.slug} node={node} />)}
          </ul>
          {pipeline.edges?.length ? (
            <ul className="wax-edges-list">
              {pipeline.edges.map((edge, i) => (
                <li key={`${edge.from}-${edge.to}-${i}`}>
                  <code className="hub-code">{edge.from}</code> → <code className="hub-code">{edge.to}</code>
                  {edge.kind ? <span className="wax-edge-kind"> ({edge.kind})</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
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
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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

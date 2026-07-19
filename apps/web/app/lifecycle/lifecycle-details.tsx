"use client";

import type { LifecycleFrontierItem, LifecycleProjection } from "@holocene/lifecycle-client";
import React from "react";
import type { LifecycleCommandReceipt } from "./lifecycle-action-contract";

type Props = {
  projection: LifecycleProjection;
  actorId: string;
  capabilityId: string;
  busyFrontierId?: string;
  commandReceipt?: LifecycleCommandReceipt;
  commandError?: string;
  onActorId: (value: string) => void;
  onCapabilityId: (value: string) => void;
  onAction: (frontier: LifecycleFrontierItem) => void;
};

export function LifecycleDetails({
  projection,
  actorId,
  capabilityId,
  busyFrontierId,
  commandReceipt,
  commandError,
  onActorId,
  onCapabilityId,
  onAction
}: Props) {
  const canAct =
    projection.projection_status === "current" &&
    Boolean(
      projection.state_version &&
        projection.source?.event_id &&
        projection.source.correlation_id
    );
  const grants = projection.capabilities.filter(
    (grant) => !actorId || grant.actor_id === actorId
  );

  return (
    <main
      className="lifecycle-shell"
      data-testid="lifecycle-surface"
      data-proof-contract="holocene-lifecycle-browser-v1"
      data-lifecycle-id={projection.lifecycle_id}
      data-projection-status={projection.projection_status}
      data-state-status={projection.status}
      data-state-version={projection.state_version ?? ""}
      data-source-event-id={projection.source?.event_id ?? ""}
      data-source-correlation-id={projection.source?.correlation_id ?? ""}
      data-source-causation-id={projection.source?.causation_id ?? ""}
    >
      <header className="lifecycle-hero">
        <div>
          <a className="lifecycle-back" href="/">
            Holocene dashboard
          </a>
          <p className="eyebrow">Lifecycle authority</p>
          <h1>{projection.repo ?? projection.lifecycle_id}</h1>
          <p className="lifecycle-id">{projection.lifecycle_id}</p>
        </div>
        <div
          className={`lifecycle-state lifecycle-state-${projection.projection_status}`}
          data-testid="lifecycle-state"
          data-projection-status={projection.projection_status}
          data-state-status={projection.status}
          data-state-version={projection.state_version ?? ""}
        >
          <span>{projection.projection_status}</span>
          <strong>{projection.status}</strong>
          <small>{projection.health}</small>
        </div>
      </header>

      {projection.projection_status !== "current" ? (
        <section className="lifecycle-alert" role="alert">
          <strong>Commands are disabled.</strong>
          <span>
            {projection.read_error ??
              `The authoritative read projection is ${projection.projection_status}; empty work is not healthy.`}
          </span>
        </section>
      ) : null}

      <section className="lifecycle-metrics" aria-label="Lifecycle versions and state">
        <Metric label="Spec version" value={display(projection.spec_version)} />
        <Metric label="State version" value={display(projection.state_version)} />
        <Metric label="Phase" value={display(projection.phase)} />
        <Metric
          label="Progress"
          value={
            projection.progress_percent === null ? "unknown" : `${projection.progress_percent}%`
          }
        />
        <Metric label="Fingerprint" value={projection.fingerprint ?? "not published"} wide />
      </section>

      <section className="lifecycle-grid">
        <Panel title="Provenance" subtitle="Authority and observation source">
          <div
            data-testid="lifecycle-source"
            data-source-event-id={projection.source?.event_id ?? ""}
            data-source-correlation-id={projection.source?.correlation_id ?? ""}
            data-source-causation-id={projection.source?.causation_id ?? ""}
          >
            <KeyValue label="Authority" value={recordValue(projection.provenance, "authority")} />
            <KeyValue
              label="Instance"
              value={recordValue(projection.provenance, "authority_instance")}
            />
            <KeyValue label="Policy" value={recordValue(projection.provenance, "policy_version")} />
            <KeyValue
              label="Reconciliation"
              value={recordValue(projection.provenance, "reconciliation_id")}
            />
            <KeyValue label="Source event" value={projection.source?.event_id ?? "unknown"} />
            <KeyValue label="Correlation" value={projection.source?.correlation_id ?? "unknown"} />
            <KeyValue label="Causation" value={projection.source?.causation_id ?? "root event"} />
            <KeyValue label="Observed event time" value={projection.source?.event_time ?? "unknown"} />
            <KeyValue label="Projected at" value={projection.source?.projected_at ?? "unknown"} />
          </div>
        </Panel>

        <Panel title="Freshness" subtitle="As reported by Lifecycle and Candystore">
          <KeyValue label="Status" value={recordValue(projection.freshness, "status")} />
          <KeyValue
            label="Observed through"
            value={recordValue(projection.freshness, "observed_through")}
          />
          <KeyValue
            label="Evaluated at"
            value={recordValue(projection.freshness, "evaluated_at")}
          />
          <KeyValue label="Read as of" value={recordValue(projection.freshness, "as_of")} />
          <KeyValue
            label="Maximum age"
            value={seconds(recordNumber(projection.freshness, "max_age_seconds"))}
          />
          {projection.authority_state && projection.projection_status === "stale" ? (
            <p className="lifecycle-note">
              Last authority health was {projection.authority_state.health}; display health is
              degraded because the observation is stale.
            </p>
          ) : null}
        </Panel>
      </section>

      <Panel
        title="Legal frontier"
        subtitle="Rendered exactly from Lifecycle; Holocene submits commands and predicts no result"
        full
      >
        <div className="lifecycle-action-context">
          <label>
            Actor ID
            <input
              data-testid="lifecycle-actor"
              value={actorId}
              onChange={(event) => onActorId(event.target.value)}
              placeholder="operator or agent identity"
            />
          </label>
          <label>
            Capability grant
            <select
              data-testid="lifecycle-capability"
              value={capabilityId}
              onChange={(event) => onCapabilityId(event.target.value)}
            >
              <option value="">Select a current grant</option>
              {grants.map((grant) => (
                <option
                  key={grant.capability_id}
                  value={grant.capability_id}
                  data-actor-id={grant.actor_id}
                  data-capability-id={grant.capability_id}
                  data-capability-version={grant.capability_version}
                  data-grant-state-version={grant.state_version}
                >
                  {grant.capability_id} · {grant.actor_id} · v{grant.capability_version}
                </option>
              ))}
            </select>
          </label>
        </div>

        {projection.legal_frontier.length === 0 ? (
          <Empty>Lifecycle returned no frontier items.</Empty>
        ) : (
          <div className="lifecycle-cards">
            {projection.legal_frontier.map((item) => (
              <article
                className="lifecycle-card"
                key={item.id}
                data-testid="lifecycle-frontier-item"
                data-frontier-id={item.id}
                data-frontier-kind={item.kind}
                data-frontier-action={item.action}
                data-frontier-allowed={item.allowed}
                data-frontier-reason-code={item.reason_code}
                data-expected-state-version={item.expected_state_version}
                data-capability-required={item.capability_required ?? ""}
              >
                <div className="lifecycle-card-head">
                  <strong>{item.id}</strong>
                  <span className={item.allowed ? "lifecycle-allowed" : "lifecycle-denied"}>
                    {item.allowed ? "allowed" : "not allowed"}
                  </span>
                </div>
                <p>{item.kind} · {item.action}</p>
                <small>{item.reason_code}</small>
                <small>Expected state v{item.expected_state_version}</small>
                {item.action === "resolve_gate" ? (
                  <small>Disabled: choose a canonical resolution before publishing.</small>
                ) : null}
                <button
                  data-testid="lifecycle-action"
                  data-frontier-id={item.id}
                  data-frontier-action={item.action}
                  data-frontier-reason-code={item.reason_code}
                  data-expected-state-version={item.expected_state_version}
                  type="button"
                  disabled={
                    !canAct ||
                    !item.allowed ||
                    item.action === "resolve_gate" ||
                    !actorId ||
                    !capabilityId ||
                    Boolean(busyFrontierId)
                  }
                  onClick={() => onAction(item)}
                >
                  {busyFrontierId === item.id ? "Publishing…" : `Submit ${item.action}`}
                </button>
              </article>
            ))}
          </div>
        )}
        {commandReceipt ? (
          <p
            className="lifecycle-command-ok"
            role="status"
            aria-live="polite"
            data-testid="lifecycle-command-success"
            data-command-id={commandReceipt.command_id}
            data-command-event-id={commandReceipt.command_event_id}
            data-correlation-id={commandReceipt.correlation_id}
            data-causation-id={commandReceipt.causation_id}
            data-broker-processed={commandReceipt.broker_processed}
            data-authority-accepted={commandReceipt.authority_accepted}
          >
            {commandReceipt.message} Command {commandReceipt.command_id}.
          </p>
        ) : null}
        {commandError ? (
          <p
            className="lifecycle-command-error"
            role="alert"
            data-testid="lifecycle-command-error"
          >
            {commandError}
          </p>
        ) : null}
      </Panel>

      <section className="lifecycle-grid">
        <Panel title="Obligations" subtitle={`${projection.obligations.length} authoritative`}>
          {projection.obligations.length === 0 ? (
            <Empty>No obligations in this projection.</Empty>
          ) : (
            projection.obligations.map((item) => (
              <article className="lifecycle-list-item" key={item.id}>
                <div><strong>{item.id}</strong><span>{item.status}</span></div>
                <p>{item.description}</p>
                <small>Occurrence {item.obligation_instance_id}</small>
                <small>Activated {item.activated_at}</small>
                <code>{item.skill_ref.name}@{item.skill_ref.selector}</code>
              </article>
            ))
          )}
        </Panel>

        <Panel title="Blockers and gates" subtitle="Authority-owned constraints">
          {projection.blockers.length === 0 && projection.gates.length === 0 ? (
            <Empty>No blockers or gates in this projection.</Empty>
          ) : (
            <>
              {projection.blockers.map((item, index) => (
                <RecordItem key={`blocker-${index}`} label="Blocker" value={item} />
              ))}
              {projection.gates.map((item, index) => (
                <RecordItem key={`gate-${index}`} label="Gate" value={item} />
              ))}
            </>
          )}
        </Panel>
      </section>

      <Panel title="Command verdicts" subtitle="Stable authority outcomes from Candystore" full>
        {projection.command_verdicts.length === 0 ? (
          <Empty>No Lifecycle command verdicts observed.</Empty>
        ) : (
          <div className="lifecycle-verdicts">
            {projection.command_verdicts.map((verdict) => (
              <article
                key={verdict.reply_event_id}
                data-testid="lifecycle-command-verdict"
                data-reply-event-id={verdict.reply_event_id}
                data-command-event-id={verdict.command_event_id}
                data-command-id={verdict.command_id}
                data-verdict={verdict.verdict}
                data-mutated={verdict.mutated}
                data-expected-state-version={verdict.expected_state_version}
                data-observed-state-version={verdict.observed_state_version}
                data-resulting-state-version={verdict.resulting_state_version ?? ""}
                data-applied-event-id={verdict.applied_event_id ?? ""}
                data-capability-id={verdict.capability_id ?? ""}
                data-reason-code={verdict.reason_code}
                data-correlation-id={verdict.correlation_id ?? ""}
                data-causation-id={verdict.causation_id ?? ""}
              >
                <span className={`lifecycle-verdict lifecycle-verdict-${verdict.verdict}`}>
                  {verdict.verdict}
                </span>
                <strong>{verdict.reason_code}</strong>
                <small>command {verdict.command_id}</small>
                <small>
                  expected v{verdict.expected_state_version} · observed v
                  {verdict.observed_state_version}
                  {verdict.resulting_state_version
                    ? ` · resulting v${verdict.resulting_state_version}`
                    : ""}
                </small>
                <small>{verdict.responded_at}</small>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </main>
  );
}

function Metric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <article className={`lifecycle-metric${wide ? " lifecycle-metric-wide" : ""}`}><span>{label}</span><strong>{value}</strong></article>;
}

function Panel({ title, subtitle, full = false, children }: { title: string; subtitle: string; full?: boolean; children: React.ReactNode }) {
  return <section className={`lifecycle-panel${full ? " lifecycle-panel-full" : ""}`}><header><h2>{title}</h2><span>{subtitle}</span></header><div className="lifecycle-panel-body">{children}</div></section>;
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return <div className="lifecycle-key-value"><span>{label}</span><strong>{value}</strong></div>;
}

function RecordItem({ label, value }: { label: string; value: Record<string, unknown> }) {
  return <article className="lifecycle-list-item"><div><strong>{label}</strong><span>{String(value.status ?? value.kind ?? "observed")}</span></div><p>{String(value.summary ?? value.reason ?? value.id ?? "No description")}</p></article>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="lifecycle-empty">{children}</p>;
}

function display(value: string | number | null) {
  return value === null || value === "" ? "unknown" : String(value);
}

function recordValue(value: Record<string, unknown> | null, key: string) {
  return value && value[key] !== undefined && value[key] !== null ? String(value[key]) : "unknown";
}

function recordNumber(value: Record<string, unknown>, key: string) {
  return typeof value[key] === "number" ? value[key] : undefined;
}

function seconds(value?: number) {
  return value === undefined ? "unknown" : `${value}s`;
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { Brand, ThemeToggle, usePoll, useTheme } from "../hub/hub-app";
import { CopyRef, Glyph, SourceStrip } from "../hub/ui";
import { HubShell } from "../hub/hub-shell";
import type { Source } from "../hub/types";
import {
  SEVERITY_SIGNAL,
  STATE_SIGNAL,
  STATE_WORD,
  agoText,
  alertIdOf,
  alertsById,
  approvalIdOf,
  approvalsById,
  clientLabel,
  decidedText,
  emailAction,
  expiryText,
  filterTimeline,
  liveState,
  needsYou,
  newerOverview,
  otherFields,
  reasonWord,
  resolutionState,
  statement,
  timelineKind,
  type TimelineFilter
} from "./model";
import { subscribeGenesis, type StreamStatus } from "./stream";
import type { Alert, Approval, GenesisEvent, GenesisOverview, Proposal } from "./types";

// The Genesis tab: every bloodbank.genesis.* fact in the shared collection, as cards. "Needs you" first (approvals
// still waiting on a client, alerts nobody acknowledged), then the timeline of every Genesis event. The page never
// holds a credential: Reply, Refresh proposals and Acknowledge go through the Holocene API, which calls Genesis's
// operator API server-side. Only the client's own session can approve or decline, so no card offers that.

const POLL_MS = 15_000;
const HIDE_TEST_KEY = "holocene.genesis.hide-test";

type ActionResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

async function call(url: string, init?: RequestInit): Promise<ActionResult> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : `${res.status} ${res.statusText}` };
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
const postJson = (url: string, body: unknown) =>
  call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function GenesisApp() {
  const [theme, toggleTheme] = useTheme();
  const [now, setNow] = useState(() => Date.now());
  const poll = usePoll<GenesisOverview>("/api/modules/genesis/overview", POLL_MS);
  const [live, setLive] = useState<GenesisOverview>();
  const [stream, setStream] = useState<{ status: StreamStatus; detail?: string }>({ status: "connecting" });
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [hideTest, setHideTest] = useState(false);

  useEffect(() => subscribeGenesis<GenesisOverview>({ onOverview: setLive, onStatus: (status, detail) => setStream({ status, detail }) }), []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    try {
      setHideTest(window.localStorage.getItem(HIDE_TEST_KEY) === "1");
    } catch {
      // storage blocked: show test events
    }
  }, []);
  const toggleHideTest = (value: boolean) => {
    setHideTest(value);
    try {
      window.localStorage.setItem(HIDE_TEST_KEY, value ? "1" : "0");
    } catch {
      // storage blocked: the choice lasts this visit
    }
  };

  const data = newerOverview(live, poll.data);
  const approvals = useMemo(() => approvalsById(data), [data]);
  const alerts = useMemo(() => alertsById(data), [data]);
  const needs = data ? needsYou(data, now, hideTest) : { approvals: [], alerts: [] };
  const timeline = data ? filterTimeline(data.timeline, filter, hideTest) : [];
  const counts = data ? {
    all: filterTimeline(data.timeline, "all", hideTest).length,
    approvals: filterTimeline(data.timeline, "approvals", hideTest).length,
    alerts: filterTimeline(data.timeline, "alerts", hideTest).length,
    other: filterTimeline(data.timeline, "other", hideTest).length
  } : undefined;

  const collection = data?.source;
  const sources: Source[] = [
    ...(collection ? [{
      name: "bloodbank",
      value: collection.state === "live" ? (collection.catchingUp ? "catching up" : "live") : collection.state,
      down: collection.state !== "live",
      detail: collection.error ?? undefined
    }] : []),
    { name: "updates", value: stream.status === "live" ? "live" : stream.status === "connecting" ? "connecting" : `polling ${POLL_MS / 1000}s`, down: false, detail: stream.detail }
  ];
  const refresh = poll.reload;

  return (
    <div className="hub-root" data-theme={theme}>
      <HubShell current="genesis">
        <Brand />
        <div className="hub-header-end">
          <SourceStrip sources={sources} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </HubShell>

      <div className="hub-body gn-body" id="hub-content" role="main" tabIndex={-1}>
        <div className="hub-lede">
          <p className="hub-statement" aria-live="polite">
            {data ? statement(data, now, hideTest) : poll.error ? "The Holocene API is not answering." : "Reading Genesis events…"}
          </p>
          {poll.error && !live ? (
            <p className="hub-error" role="status">
              <span className="hub-label">API</span>
              {data ? `Showing the last good read. ${poll.error}` : poll.error}
            </p>
          ) : null}
        </div>

        {data ? (
          <>
            <section className="gn-section" aria-labelledby="gn-needs">
              <h2 className="gn-head" id="gn-needs">
                <span className="hub-label">Needs you</span>
                <span className="gn-count">{needs.approvals.length + needs.alerts.length}</span>
              </h2>
              {needs.alerts.length || needs.approvals.length ? (
                <div className="gn-cards">
                  {needs.alerts.map((a) => <AlertCard key={a.alert_id} alert={a} now={now} onChanged={refresh} />)}
                  {needs.approvals.map((a) => <ApprovalCard key={a.approval_id} approval={a} now={now} />)}
                </div>
              ) : (
                <p className="gn-empty">Nothing is waiting. Pending approvals and open alerts show up here the moment Genesis publishes them.</p>
              )}
            </section>

            <section className="gn-section" aria-labelledby="gn-timeline">
              <div className="gn-timeline-head">
                <h2 className="gn-head" id="gn-timeline">
                  <span className="hub-label">Every Genesis event</span>
                  <span className="gn-count">{data.counts.events}</span>
                </h2>
                <div className="gn-controls">
                  <div className="gn-filter" role="group" aria-label="Show">
                    {(["all", "approvals", "alerts", "other"] as const).map((f) => (
                      <button key={f} type="button" className="gn-seg" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                        {f} <span className="gn-seg-count">{counts?.[f] ?? 0}</span>
                      </button>
                    ))}
                  </div>
                  <label className="gn-check">
                    <input type="checkbox" checked={hideTest} onChange={(e) => toggleHideTest(e.target.checked)} />
                    Hide test events
                  </label>
                </div>
              </div>
              {timeline.length ? (
                <ol className="gn-timeline">
                  {timeline.map((e) => (
                    <li key={e.id}>
                      <TimelineCard event={e} now={now} approvals={approvals} alerts={alerts} onChanged={refresh} />
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="gn-empty">{data.counts.events ? "No events match this filter." : "No Genesis events in the collection yet."}</p>
              )}
            </section>
          </>
        ) : null}

        <footer className="hub-foot">
          <span>Every bloodbank.genesis.* fact, read from the shared Bloodbank collection.</span>
          <span>Reply, proposals and acknowledgements reach Genesis through the Holocene API; this page holds no credentials.</span>
          <a href="https://genesis.delo.sh/operator" target="_blank" rel="noopener noreferrer">Genesis operator console</a>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- cards

function TimelineCard({ event, now, approvals, alerts, onChanged }: {
  event: GenesisEvent; now: number; approvals: Map<string, Approval>; alerts: Map<string, Alert>; onChanged: () => void;
}) {
  const kind = timelineKind(event);
  if (kind === "approval") {
    const id = approvalIdOf(event);
    const approval = id ? approvals.get(id) : undefined;
    if (approval) return <ApprovalCard approval={approval} now={now} compact />;
  }
  if (kind === "alert") {
    const id = alertIdOf(event);
    const alert = id ? alerts.get(id) : undefined;
    if (alert) return <AlertCard alert={alert} now={now} onChanged={onChanged} compact />;
  }
  if (kind === "resolution") return <ResolutionCard event={event} now={now} approval={approvals.get(approvalIdOf(event) ?? "")} />;
  return <GenericCard event={event} now={now} />;
}

function Who({ x }: { x: { client_name: string | null; client_id: string | null; bot_id: string | null; test: boolean } }) {
  const role = x.bot_id?.includes(":") ? x.bot_id.slice(x.bot_id.lastIndexOf(":") + 1) : x.bot_id;
  return (
    <span className="gn-who">
      <span className="gn-client" title={x.client_id ?? undefined}>{clientLabel(x)}</span>
      {x.bot_id ? <CopyRef value={x.bot_id} label={role ?? x.bot_id} /> : null}
      {x.test ? <span className="gn-chip is-test" title="A synthetic or test-client event">test</span> : null}
    </span>
  );
}

function When({ iso, now, verb }: { iso: string | null | undefined; now: number; verb?: string }) {
  if (!iso) return null;
  return (
    <time className="gn-when" dateTime={iso} title={new Date(iso).toLocaleString()}>
      {verb ? `${verb} ` : ""}{agoText(iso, now)}
    </time>
  );
}

function OpenLink({ url }: { url: string | null }) {
  if (!url) return null;
  return <a className="hub-btn gn-btn" href={url} target="_blank" rel="noopener noreferrer">Open in Genesis</a>;
}

function ApprovalCard({ approval: a, now, compact }: { approval: Approval; now: number; compact?: boolean }) {
  const state = liveState(a, now);
  const email = emailAction(a.action);
  const [replying, setReplying] = useState(false);
  const [proposals, setProposals] = useState(false);
  const expiry = state === "pending" || state === "lapsed" ? expiryText(a.expires_at, now) : undefined;
  const body = (
    <>
      {a.question ? <p className="gn-question">{a.question}</p> : null}
      {email ? (
        <dl className="gn-fields">
          {email.to.length ? <><dt>To</dt><dd>{email.to.join(", ")}</dd></> : null}
          {email.cc.length ? <><dt>Cc</dt><dd>{email.cc.join(", ")}</dd></> : null}
          {email.subject ? <><dt>Subject</dt><dd>{email.subject}</dd></> : null}
          {email.bodyPreview ? <><dt>Body</dt><dd className="gn-preview">{email.bodyPreview}</dd></> : null}
          {email.extra.map(([k, v]) => <FieldRow key={k} k={k} v={v} />)}
        </dl>
      ) : otherFields(a.action).length ? (
        <dl className="gn-fields">{otherFields(a.action).map(([k, v]) => <FieldRow key={k} k={k} v={v} />)}</dl>
      ) : null}
    </>
  );
  return (
    <article className={`gn-card is-approval is-${state}`} aria-label={`Approval ${a.approval_id}`}>
      <header className="gn-card-head">
        <Glyph signal={STATE_SIGNAL[state]} size={11} title={STATE_WORD[state]} />
        <span className="gn-kind">Approval{a.kind ? ` · ${a.kind}` : ""}</span>
        <span className={`gn-chip is-${state}`}>{STATE_WORD[state]}</span>
        <Who x={a} />
        <When iso={a.requested_at ?? a.resolved_at} now={now} verb={a.requested ? "asked" : undefined} />
      </header>
      {a.summary ? <p className="gn-summary">{a.summary}</p> : null}
      {compact ? (
        <details className="gn-more">
          <summary>Question and draft</summary>
          {body}
        </details>
      ) : body}
      <p className="gn-status">
        {expiry ? <span className={state === "lapsed" ? "gn-lapsed" : "gn-expiry"}>{expiry}</span> : null}
        {state === "pending" ? <span>Only the client can decide this{a.channel ? ` (card shown on ${a.channel})` : ""}.</span> : null}
        {state === "lapsed" ? <span>No answer before the deadline. Refreshing the client&apos;s proposals lets Genesis expire it.</span> : null}
        {decidedText({ ...a, state }, now) ? <span>{decidedText({ ...a, state }, now)}</span> : null}
        {!a.requested ? <span>The request is no longer in the collection.</span> : null}
      </p>
      <div className="gn-actions">
        <OpenLink url={a.operator_url} />
        {a.client_id ? (
          <>
            <button type="button" className="hub-btn gn-btn" aria-expanded={replying} onClick={() => setReplying((v) => !v)}>Reply</button>
            <button type="button" className="hub-btn gn-btn is-ghost" aria-expanded={proposals} onClick={() => setProposals((v) => !v)}>
              {proposals ? "Hide proposals" : "Refresh proposals"}
            </button>
          </>
        ) : null}
        <CopyRef value={a.approval_id} />
      </div>
      {replying && a.client_id ? <ReplyBox clientId={a.client_id} who={clientLabel(a)} onClose={() => setReplying(false)} /> : null}
      {proposals && a.client_id ? <ProposalsPanel clientId={a.client_id} highlight={a.approval_id} /> : null}
    </article>
  );
}

function FieldRow({ k, v }: { k: string; v: string }) {
  return <><dt>{k.replace(/_/g, " ")}</dt><dd>{v}</dd></>;
}

function AlertCard({ alert: a, now, compact, onChanged }: { alert: Alert; now: number; compact?: boolean; onChanged: () => void }) {
  const [replying, setReplying] = useState(false);
  const [ack, setAck] = useState<{ busy: boolean; note?: string; error?: string }>({ busy: false });
  const acknowledge = async () => {
    setAck({ busy: true });
    const r = await postJson(`/api/modules/genesis/alerts/${encodeURIComponent(a.alert_id)}/ack`, {});
    if (r.ok) {
      setAck({ busy: false, note: typeof r.body.note === "string" ? r.body.note : "Acknowledged." });
      onChanged();
    } else setAck({ busy: false, error: r.error });
  };
  const signal = a.acknowledged ? "cleared" : SEVERITY_SIGNAL[a.severity];
  return (
    <article className={`gn-card is-alert is-${a.severity}${a.acknowledged ? " is-acked" : ""}`} aria-label={`Alert ${a.alert_id}`}>
      <header className="gn-card-head">
        <Glyph signal={signal} size={11} title={a.acknowledged ? "acknowledged" : a.severity} />
        <span className="gn-kind">{reasonWord(a.reason)}</span>
        <span className={`gn-chip is-sev-${a.severity}`}>{a.severity}</span>
        {a.acknowledged ? <span className="gn-chip is-approved">acknowledged</span> : null}
        <Who x={a} />
        <When iso={a.raised_at} now={now} verb="raised" />
      </header>
      {a.summary ? <p className="gn-summary">{a.summary}</p> : null}
      {a.detail ? (
        compact ? (
          <details className="gn-more"><summary>Detail</summary><p className="gn-detail">{a.detail}</p></details>
        ) : <p className="gn-detail">{a.detail}</p>
      ) : null}
      {a.acknowledged ? (
        <p className="gn-status"><span>Acknowledged {agoText(a.acknowledged_at, now) ?? ""}{a.acknowledged_via === "genesis" ? " in Genesis" : " in Holocene"}.</span></p>
      ) : null}
      <div className="gn-actions">
        <OpenLink url={a.operator_url} />
        {a.client_id ? <button type="button" className="hub-btn gn-btn" aria-expanded={replying} onClick={() => setReplying((v) => !v)}>Reply</button> : null}
        {!a.acknowledged ? (
          <button type="button" className="hub-btn gn-btn" disabled={ack.busy} onClick={() => void acknowledge()}>
            {ack.busy ? "Acknowledging…" : "Acknowledge"}
          </button>
        ) : null}
        <CopyRef value={a.alert_id} />
      </div>
      {ack.note ? <p className="gn-result" role="status">{ack.note}</p> : null}
      {ack.error ? <p className="gn-result is-error" role="alert">Not acknowledged: {ack.error}</p> : null}
      {replying && a.client_id ? <ReplyBox clientId={a.client_id} who={clientLabel(a)} onClose={() => setReplying(false)} /> : null}
    </article>
  );
}

function ResolutionCard({ event: e, now, approval }: { event: GenesisEvent; now: number; approval?: Approval }) {
  const state = resolutionState(e.action) ?? "expired";
  const via = typeof e.data.decided_via === "string" ? e.data.decided_via : undefined;
  return (
    <article className={`gn-card is-resolution is-${state}`} aria-label={e.type}>
      <header className="gn-card-head">
        <Glyph signal={STATE_SIGNAL[state]} size={11} title={STATE_WORD[state]} />
        <span className="gn-kind">Approval {STATE_WORD[state].toLowerCase()}{via && via !== "expiry" ? ` via ${via}` : ""}</span>
        <Who x={e} />
        <When iso={e.time ?? e.collected_at} now={now} />
      </header>
      <p className="gn-summary">{e.summary ?? approval?.summary ?? e.type}</p>
      <JsonDetails event={e} />
    </article>
  );
}

function GenericCard({ event: e, now }: { event: GenesisEvent; now: number }) {
  return (
    <article className="gn-card is-generic" aria-label={e.type}>
      <header className="gn-card-head">
        <Glyph signal="unknown" size={11} />
        <span className="gn-kind gn-type">{e.type.replace(/^bloodbank\.genesis\./, "")}</span>
        <Who x={e} />
        <When iso={e.time ?? e.collected_at} now={now} />
      </header>
      {e.summary ? <p className="gn-summary">{e.summary}</p> : null}
      <div className="gn-actions"><OpenLink url={e.operator_url} /></div>
      <JsonDetails event={e} open={!e.summary} />
    </article>
  );
}

function JsonDetails({ event: e, open }: { event: GenesisEvent; open?: boolean }) {
  return (
    <details className="gn-more" open={open}>
      <summary>Data · {e.type}</summary>
      <pre className="gn-json">{JSON.stringify(e.data, null, 2)}</pre>
    </details>
  );
}

// ---------------------------------------------------------------- actions

type ReplyPhase = "edit" | "confirm" | "sending" | "sent" | "error";

/** Client-visible: a confirm step stands between the draft and Genesis. */
function ReplyBox({ clientId, who, onClose }: { clientId: string; who: string; onClose: () => void }) {
  const [phase, setPhase] = useState<ReplyPhase>("edit");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<string>();
  const send = async () => {
    setPhase("sending");
    const r = await postJson(`/api/modules/genesis/clients/${encodeURIComponent(clientId)}/reply`, { message, confirmed: true });
    if (r.ok) {
      const at = typeof r.body.sent_at === "string" ? new Date(r.body.sent_at).toLocaleTimeString() : "";
      setResult(`Delivered to ${who}'s assistant${at ? ` at ${at}` : ""}.`);
      setPhase("sent");
    } else {
      setResult(r.error);
      setPhase("error");
    }
  };
  return (
    <div className="gn-reply">
      {phase === "edit" ? (
        <>
          <label className="hub-label" htmlFor={`reply-${clientId}`}>Reply to {who} through their assistant</label>
          <textarea
            id={`reply-${clientId}`}
            className="gn-textarea"
            rows={4}
            maxLength={4000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What the assistant should pass on"
          />
          <div className="gn-actions">
            <button type="button" className="hub-btn gn-btn" disabled={!message.trim()} onClick={() => setPhase("confirm")}>Review</button>
            <button type="button" className="hub-btn gn-btn is-ghost" onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : phase === "confirm" || phase === "sending" ? (
        <>
          <p className="gn-confirm"><strong>{who} will see this.</strong> It goes to their assistant, which relays it in their chat:</p>
          <blockquote className="gn-quote">{message.trim()}</blockquote>
          <div className="gn-actions">
            <button type="button" className="hub-btn gn-btn is-send" disabled={phase === "sending"} onClick={() => void send()}>
              {phase === "sending" ? "Sending…" : "Send to client"}
            </button>
            <button type="button" className="hub-btn gn-btn is-ghost" disabled={phase === "sending"} onClick={() => setPhase("edit")}>Edit</button>
          </div>
        </>
      ) : phase === "sent" ? (
        <div className="gn-actions">
          <p className="gn-result" role="status">{result}</p>
          <button type="button" className="hub-btn gn-btn is-ghost" onClick={onClose}>Close</button>
        </div>
      ) : (
        <div className="gn-actions">
          <p className="gn-result is-error" role="alert">Not sent: {result}</p>
          <button type="button" className="hub-btn gn-btn is-ghost" onClick={() => setPhase("edit")}>Edit</button>
        </div>
      )}
    </div>
  );
}

/** The client's proposals as Genesis has them now (reading them is also what lets Genesis expire overdue ones). */
function ProposalsPanel({ clientId, highlight }: { clientId: string; highlight?: string }) {
  const [state, setState] = useState<{ loading: boolean; proposals?: Proposal[]; error?: string; at?: string }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    void call(`/api/modules/genesis/clients/${encodeURIComponent(clientId)}/proposals`).then((r) => {
      if (!live) return;
      if (r.ok) setState({ loading: false, proposals: Array.isArray(r.body.proposals) ? (r.body.proposals as Proposal[]) : [], at: String(r.body.fetched_at ?? "") });
      else setState({ loading: false, error: r.error });
    });
    return () => { live = false; };
  }, [clientId, nonce]);
  return (
    <div className="gn-proposals">
      <div className="gn-proposals-head">
        <span className="hub-label">Proposals in Genesis</span>
        <button type="button" className="hub-btn gn-btn is-ghost" disabled={state.loading} onClick={() => setNonce((n) => n + 1)}>
          {state.loading ? "Reading…" : "Refresh"}
        </button>
      </div>
      {state.error ? <p className="gn-result is-error" role="alert">{state.error}</p> : null}
      {state.proposals && !state.proposals.length ? <p className="gn-empty">No proposals for this client.</p> : null}
      {state.proposals?.length ? (
        <ul className="gn-proposal-list">
          {state.proposals.slice(0, 10).map((p) => (
            <li key={p.id} className={p.id === highlight ? "is-this" : undefined}>
              <span className={`gn-chip is-${p.status === "proposed" ? "pending" : p.status === "sent" || p.status === "approved" ? "approved" : p.status === "rejected" ? "declined" : "expired"}`}>{p.status ?? "?"}</span>
              <span className="gn-proposal-subject">{p.subject ?? p.kind ?? p.id}</span>
              {p.to?.length ? <span className="gn-proposal-to">to {p.to.join(", ")}</span> : null}
              {p.error ? <span className="gn-proposal-error">{p.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

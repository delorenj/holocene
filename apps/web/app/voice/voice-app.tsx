"use client";

import { useCallback, useEffect, useState } from "react";
import { Brand, ThemeToggle, usePoll, useTheme } from "../hub/hub-app";
import { CopyRef, Glyph, SourceStrip, formatDuration } from "../hub/ui";
import type { Source } from "../hub/types";
import { HOP_SIGNAL, HOP_WORD, MEMO_SIGNAL, clockTime, dayTime, formatLatency, laneQueueText, liveTotal, statement } from "./model";
import type { Hop, HopFailure, Lane, MemoDetail, MemoPayload, MemosPayload, MemoSummary, WatcherStatus } from "./types";

// Voice memos: the memo:trace timeline for every memo, drawn from the Bloodbank collection.
// Read-only. The API groups the facts by correlation id; this file only draws them.

const POLL_MS = 4000;

function readMemo(): string | undefined {
  return new URLSearchParams(window.location.search).get("memo") ?? undefined;
}

function writeMemo(id: string | undefined) {
  const q = new URLSearchParams(window.location.search);
  if (id) q.set("memo", id);
  else q.delete("memo");
  const qs = q.toString();
  window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
}

export function VoiceApp() {
  const [theme, toggleTheme] = useTheme();
  const [now, setNow] = useState(() => Date.now());
  const [picked, setPicked] = useState<string>();
  const list = usePoll<MemosPayload>("/api/modules/voice/memos?limit=40", POLL_MS);

  useEffect(() => setPicked(readMemo()), []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const memos = list.data?.memos ?? [];
  const selected = picked ?? memos[0]?.memoId;
  const select = useCallback((id: string) => {
    setPicked(id);
    writeMemo(id);
  }, []);

  const collection = list.data?.source;
  const sources: Source[] = collection
    ? [{
        name: "bloodbank",
        value: collection.state === "live" ? (collection.catchingUp ? "catching up" : "live") : collection.state,
        down: collection.state !== "live",
        detail: collection.error ?? undefined
      }]
    : [];

  return (
    <div className="hub-root" data-theme={theme}>
      <header className="hub-header">
        <Brand />
        <nav className="hub-tabs" aria-label="Views">
          <a className="hub-tab" href="/?view=agents">Agents</a>
          <a className="hub-tab" href="/?view=projects">Projects</a>
          <a className="hub-tab" href="/voice" aria-current="page">Voice</a>
        </nav>
        <div className="hub-header-end">
          <SourceStrip sources={sources} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="hub-body">
        <div className="hub-lede">
          <p className="hub-statement" aria-live="polite">
            {list.data ? statement(memos) : list.error ? "The Holocene API is not answering." : "Reading the memo journeys…"}
          </p>
          {list.error ? (
            <p className="hub-error" role="status">
              <span className="hub-label">API</span>
              {list.data ? `Showing the last good read. ${list.error}` : list.error}
            </p>
          ) : null}
        </div>

        {list.data?.watcher && list.data.watcher.state !== "running" ? (
          <div className="voice-alert" role="alert">
            <span className="hub-label">Watcher {list.data.watcher.state}</span>
            <p>{list.data.watcher.detail}. Fix: <code>systemctl --user restart holocene-inbox-watcher</code></p>
          </div>
        ) : null}

        {list.data?.watcher?.state === "running" && list.data.watcher.lane === "interactive"
          && list.data.watcher.lanes?.interactive?.pulling === false ? (
          list.data.watcher.lanes?.batch?.pulling === true ? (
            <div className="voice-alert" role="alert">
              <span className="hub-label">Interactive lane not pulling</span>
              <p>
                Nobody is pulling the interactive gateway consumer but the batch lane is alive, so memos are being sent on the batch lane and may wait behind ticket grooming.
                {" "}{laneQueueText("batch", list.data.watcher.lanes?.batch)}. Check <code>gateway.platforms.bloodbank.extra.interactive</code> and the interactive durable.
              </p>
            </div>
          ) : (
            <div className="voice-alert" role="alert">
              <span className="hub-label">Gateway not pulling</span>
              <p>
                Neither gateway lane is being pulled (<code>hermes-gateway.service</code> is down or reconnecting, about 2 min after a restart).
                Memos stay on the interactive lane and start first when it comes back.
              </p>
            </div>
          )
        ) : null}

        {list.data && !memos.length ? (
          <div className="hub-placeholder">
            <span className="hub-label">No memos</span>
            <p>Record one in Agent Pad. Facts named bloodbank.audio.memo.* appear here within seconds.</p>
          </div>
        ) : list.data ? (
          <div className="voice-grid">
            <MemoList memos={memos} selected={selected} now={now} onSelect={select} />
            {selected ? <Journey memoId={selected} now={now} /> : null}
          </div>
        ) : null}

        <footer className="hub-foot">
          <span>Holocene reads Bloodbank; it never publishes.</span>
          <span>Refreshes every {POLL_MS / 1000}s. Same journey as `mise run memo:trace` in services/inbox-watcher.</span>
          <a href="/">Hub</a>
          <a href="/hooks">Hooks</a>
        </footer>
      </div>
    </div>
  );
}

function MemoList({ memos, selected, now, onSelect }: { memos: MemoSummary[]; selected?: string; now: number; onSelect: (id: string) => void }) {
  return (
    <section className="voice-list" aria-label="Recent voice memos">
      <h2 className="hub-label voice-colhead">Recent memos</h2>
      <ul>
        {memos.map((m) => (
          <li key={m.memoId}>
            <button
              type="button"
              className={`voice-row is-${m.status}${m.memoId === selected ? " is-selected" : ""}`}
              aria-pressed={m.memoId === selected}
              onClick={() => onSelect(m.memoId)}
            >
              <span className="voice-row-top">
                <Glyph signal={MEMO_SIGNAL[m.status]} size={11} title={m.status} />
                <span className="voice-agent">{m.agent ?? "unknown agent"}</span>
                <time className="voice-when" dateTime={m.startedAt} title={m.startedAt}>{dayTime(m.startedAt)}</time>
                <span className="voice-total">{formatDuration(liveTotal(m, now))}</span>
              </span>
              <span className="voice-preview">{m.transcriptPreview ?? <em>no transcript yet</em>}</span>
              <span className="voice-row-foot">
                <span className={`voice-stage is-${m.status}`}>{m.stageLabel}</span>
                {m.lane ? <LaneChip lane={m.lane} reason={m.laneReason} /> : null}
                {m.status === "stuck" ? <span className="voice-badge is-stuck">stuck</span> : null}
                {m.status === "failed" ? <span className="voice-badge is-failed">failed</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LaneChip({ lane, reason }: { lane: Lane; reason?: string }) {
  return (
    <span className={`voice-lane is-${lane}${reason ? " is-fallback" : ""}`} title={reason ? `fell back to batch: ${reason}` : `${lane} lane`}>
      {lane}{reason ? " (fallback)" : ""}
    </span>
  );
}

function Journey({ memoId, now }: { memoId: string; now: number }) {
  const poll = usePoll<MemoPayload>(`/api/modules/voice/memos/${memoId}`, POLL_MS);
  // Switching memos must not show the previous memo's journey under the new heading.
  const memo = poll.data?.memo.memoId === memoId ? poll.data.memo : undefined;
  if (!memo) {
    return (
      <section className="voice-detail">
        <div className="hub-placeholder">
          <span className="hub-label">{poll.error ? "No data" : "Loading"}</span>
          <p>{poll.error ? `GET /api/modules/voice/memos/${memoId} failed: ${poll.error}` : "Joining the stage facts…"}</p>
        </div>
      </section>
    );
  }
  return <Timeline memo={memo} now={now} error={poll.error} watcher={poll.data?.watcher} />;
}

function Timeline({ memo, now, error, watcher }: { memo: MemoDetail; now: number; error?: string; watcher?: WatcherStatus }) {
  const total = liveTotal(memo, now);
  const lastAt = [...memo.hops].reverse().find((h) => h.at && h.events.length)?.at;
  return (
    <section className="voice-detail" aria-label="Memo journey">
      <header className={`voice-summary is-${memo.status}`}>
        <div className="voice-summary-main">
          <Glyph signal={MEMO_SIGNAL[memo.status]} size={16} />
          <div>
            <p className="voice-summary-title">
              {memo.agent ?? "Unknown agent"} <span className="voice-summary-state">{memo.stageLabel}</span>
            </p>
            <p className="hub-note">
              {dayTime(memo.startedAt)} · total {formatLatency(total * 1000)}
              {memo.lane ? <> · <LaneChip lane={memo.lane} reason={memo.laneReason} /></> : null}
            </p>
          </div>
        </div>
        <dl className="voice-ids">
          <div><dt>memo</dt><dd><CopyRef value={memo.memoId} /></dd></div>
          {memo.commandId ? <div><dt>command</dt><dd><CopyRef value={memo.commandId} /></dd></div> : null}
          {memo.s3Key ? <div><dt>audio</dt><dd><CopyRef value={memo.s3Key} /></dd></div> : null}
        </dl>
      </header>
      {error ? <p className="hub-error" role="status"><span className="hub-label">API</span>Showing the last good read. {error}</p> : null}

      {memo.error ? (
        <div className="voice-alert" role="alert">
          <span className="hub-label">Failed</span>
          <p>{memo.error}</p>
        </div>
      ) : null}

      {memo.transcript || memo.replyText ? (
        <div className="voice-text">
          {memo.transcript ? <blockquote><span className="hub-label">Heard</span><p>{memo.transcript}</p></blockquote> : null}
          {memo.replyText ? <blockquote><span className="hub-label">Agent said</span><p>{memo.replyText}</p></blockquote> : null}
        </div>
      ) : null}

      <ol className="voice-hops">
        {memo.hops.map((hop, i) => (
          <HopRow key={hop.id} hop={hop} last={i === memo.hops.length - 1} now={now} basis={lastAt} watcher={watcher} lane={memo.lane} />
        ))}
      </ol>
    </section>
  );
}

// Hops the inbox watcher is responsible for: if it is down, that is why they are stuck.
const WATCHER_HOPS = new Set(["received", "transcribed", "dispatched", "replied"]);

/** "turn stopped · lane limit 300s": what the gateway did when the agent's turn outlived its wall clock. */
function timeoutMeta(t: NonNullable<HopFailure["timeout"]>): string {
  const parts = [t.stopped === false ? "stop not confirmed, the turn may still be unwinding" : "turn stopped"];
  if (t.limitSeconds !== undefined) parts.push(`${t.source === "envelope" ? "command deadline" : `${t.lane ?? "lane"} limit`} ${t.limitSeconds}s`);
  return parts.join(" · ");
}

function HopRow({ hop, last, now, basis, watcher, lane }: { hop: Hop; last: boolean; now: number; basis?: string; watcher?: WatcherStatus; lane?: Lane }) {
  const live = hop.status === "waiting" || hop.status === "stuck";
  const waited = live && basis ? Math.max(hop.waitedSeconds ?? 0, (now - Date.parse(basis)) / 1000) : undefined;
  return (
    <li className={`voice-hop is-${hop.status}${last ? " is-last" : ""}`}>
      <span className="voice-rail" aria-hidden="true"><Glyph signal={HOP_SIGNAL[hop.status]} size={13} /></span>
      <div className="voice-hop-body">
        <div className="voice-hop-head">
          <h3 className="voice-hop-name">{hop.label}</h3>
          <span className={`voice-badge is-${hop.status}`}>{HOP_WORD[hop.status]}</span>
          {hop.at && hop.events.length ? <time className="voice-hop-time" dateTime={hop.at} title={hop.at}>{clockTime(hop.at)}</time> : null}
          {hop.sinceMs !== undefined ? <span className="voice-hop-lat" title="since the previous hop">+{formatLatency(hop.sinceMs)}</span> : null}
          {waited !== undefined ? (
            <span className={`voice-hop-lat is-${hop.status}`}>
              waiting {formatLatency(waited * 1000)} of expected {formatLatency(hop.budgetSeconds * 1000)}
            </span>
          ) : null}
        </div>
        {hop.detail ? <p className="voice-hop-detail">{hop.detail}</p> : null}
        {live && hop.id === "agent_started" && lane && laneQueueText(lane, watcher?.lanes?.[lane]) ? (
          <p className="voice-hop-detail">Gateway: {laneQueueText(lane, watcher?.lanes?.[lane])}</p>
        ) : null}
        {live && watcher && watcher.state !== "running" && WATCHER_HOPS.has(hop.id) ? (
          <p className="voice-hop-detail"><strong>Cause: {watcher.detail}.</strong></p>
        ) : null}
        {hop.status === "missing" ? <p className="voice-hop-detail">No fact for this hop, though later hops happened.</p> : null}
        {hop.error ? (
          <div className="voice-error">
            <span className="voice-error-code">{hop.error.code ?? "error"}</span>
            <span className="voice-error-msg">{hop.error.message ?? "No message."}</span>
            {hop.error.retryable ? <span className="voice-error-meta">retryable · attempt {hop.error.attempt ?? "?"}</span> : null}
            {hop.error.timeout ? <span className="voice-error-meta">{timeoutMeta(hop.error.timeout)}</span> : null}
          </div>
        ) : null}
        {hop.failures.length > (hop.error ? 1 : 0) || (hop.status === "ok" && hop.failures.length) ? (
          <ul className="voice-attempts" aria-label="Failed attempts">
            {hop.failures.map((f) => (
              <li key={f.eventId}>
                <time dateTime={f.at}>{clockTime(f.at)}</time> attempt {f.attempt ?? "?"} {f.code ?? "failed"}: {f.message ?? ""}
              </li>
            ))}
          </ul>
        ) : null}
        {hop.events.length ? (
          <details className="voice-raw">
            <summary>Raw events ({hop.events.length})</summary>
            {hop.events.map((e) => (
              <pre key={e.id} className="voice-json" tabIndex={0}>{JSON.stringify(e.envelope, null, 2)}</pre>
            ))}
          </details>
        ) : null}
      </div>
    </li>
  );
}

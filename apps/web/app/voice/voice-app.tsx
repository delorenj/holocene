"use client";

import { useCallback, useEffect, useState } from "react";
import { Brand, ThemeToggle, usePoll, useTheme } from "../hub/hub-app";
import { CopyRef, Glyph, HubTabs, SourceStrip, formatDuration } from "../hub/ui";
import type { Source } from "../hub/types";
import { ESCALATED_REASON, HOP_SIGNAL, HOP_WORD, MEMO_SIGNAL, attemptText, audioChip, captureChip, clockTime, convLabel, dayTime, delegationLabel, formatLatency, gatewayPauseLabel, gatewayPauseSentence, laneQueueText, liveTotal, modelAtRoute, permText, phoneCopyText, statement } from "./model";
import type { ConvChip, FollowUp, Hop, HopFailure, Lane, MemoDetail, MemoPayload, MemosPayload, MemoSummary, MemoTiming, WatcherStatus } from "./types";

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
        <HubTabs current="voice" />
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

        {list.data?.watcher?.state === "running"
          && (list.data.watcher.lanes?.interactive?.draining || list.data.watcher.lanes?.batch?.draining) ? (
          <div className="voice-alert" role="status">
            <span className="hub-label">{gatewayPauseLabel(list.data.watcher.lanes)}</span>
            <p>
              {gatewayPauseSentence(list.data.watcher.lanes)}.
              {" "}<code>hermes-gateway.service</code> pulls no new commands on purpose until it takes turns again
              ({list.data.watcher.lanes?.interactive?.queued ?? 0} queued on interactive,
              {" "}{list.data.watcher.lanes?.batch?.queued ?? 0} on batch).
            </p>
          </div>
        ) : list.data?.watcher?.state === "running" && list.data.watcher.lane === "interactive"
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
              {m.latestProgress && (m.status === "running" || m.status === "stuck") ? (
                <span className="voice-progress-line" title={`${m.progressCount ?? 1} progress lines from the agent${m.narrationCount ? `, ${m.narrationCount} spoken in the car` : ""}`}>
                  {m.latestProgress}
                </span>
              ) : null}
              <span className="voice-row-foot">
                <span className={`voice-stage is-${m.status}`}>{m.stageLabel}</span>
                {m.conv ? <ConvChips conv={m.conv} /> : null}
                {m.lane ? <LaneChip lane={m.lane} reason={m.laneReason} /> : null}
                {m.late ? <LateChip /> : null}
                {m.detached ? <DetachedChip /> : null}
                {m.followup ? <FollowupChip followup={m.followup} /> : null}
                {m.audio ? <span className={`voice-level${m.audio.silent ? " is-silent" : ""}`} title="loudest sample of the recording, measured before transcribing">{audioChip(m.audio)}</span> : null}
                {m.status === "stuck" ? <span className="voice-badge is-stuck">stuck</span> : null}
                {m.status === "failed" ? <span className="voice-badge is-failed">failed</span> : null}
                {m.status === "cancelled" ? <span className="voice-badge is-cancelled">cancelled</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LaneChip({ lane, reason }: { lane: Lane; reason?: string }) {
  // An escalation is the watcher doing its job after a turn timeout; a fallback is the gateway lane being down.
  if (reason === ESCALATED_REASON) {
    return <span className="voice-lane is-escalated" title="the interactive turn timed out; the same prompt was re-dispatched on the batch lane">{lane} (escalated)</span>;
  }
  return (
    <span className={`voice-lane is-${lane}${reason ? " is-fallback" : ""}`} title={reason ? `fell back to batch: ${reason}` : `${lane} lane`}>
      {lane}{reason ? " (fallback)" : ""}
    </span>
  );
}

function LateChip() {
  return <span className="voice-flag is-late" title="the reply was spoken late: the agent finished after the memo's first deadline">late reply</span>;
}

function DetachedChip() {
  return <span className="voice-flag is-detached" title="the interactive turn passed the gateway's 300 s wall clock and was let run on (no kill, no batch re-run); its reply is spoken late">detached</span>;
}

const FOLLOWUP_WORD: Record<FollowUp["status"], string> = { running: "running", spoken: "spoken", failed: "failed" };

function FollowupChip({ followup }: { followup: NonNullable<MemoSummary["followup"]> }) {
  const delegation = followup.kind === "delegation";
  return (
    <span className={`voice-flag is-followup is-${followup.status}`}
      title={delegation
        ? `${delegationLabel(followup.target, followup.title)}: the brief the driver confirmed aloud, run on the batch lane and spoken later as "<agent>, follow-up on <title>."`
        : "answer-then-background: the agent answered in a sentence or two and handed the long part to a background follow-up on the same conversation, spoken later as a follow-up"}>
      {delegation ? "delegated" : "follow-up"} {FOLLOWUP_WORD[followup.status]}{followup.status === "running" && followup.seconds !== undefined ? ` ${formatDuration(followup.seconds)}` : ""}
    </span>
  );
}

/** The fast conversation desk's chips: conv id and turn, the action it took, and the model that answered @ its ladder rung. */
function ConvChips({ conv }: { conv: ConvChip }) {
  const model = modelAtRoute(conv);
  return (
    <>
      <span className="voice-flag is-conv" title={`fast conversation desk, conversation ${conv.convId}${conv.turn !== undefined ? `, turn ${conv.turn}` : ""}`}>{convLabel(conv)}</span>
      <span className={`voice-flag is-action${conv.fast ? " is-fast" : ""}`}
        title={conv.fast ? "spoken by the fast desk itself: no agent turn for this memo" : "handed to the full agent: today's interactive path"}>
        {conv.action}
      </span>
      {model ? <span className="voice-level voice-model" title="the model that answered @ the ladder rung (never an Anthropic route)">{model}</span>
        : conv.fast ? <span className="voice-level voice-model" title="a confirm or cancel the lexicon caught: no model call">no model call</span> : null}
    </>
  );
}

function FollowUps({ memo }: { memo: MemoDetail }) {
  const list = memo.followups ?? [];
  if (!list.length) return null;
  const delegations = list.filter((f) => f.kind === "delegation").length;
  return (
    <section className="voice-followups" aria-label={delegations === list.length ? "Delegations" : "Background follow-ups"}>
      <h3 className="hub-label">
        {delegations === list.length
          ? `Delegated: the brief${list.length > 1 ? "s" : ""} the driver confirmed, run by the agent and spoken later`
          : `Follow-up${list.length > 1 ? "s" : ""}: the long part, after the quick answer`}
      </h3>
      <ol>
        {list.map((f) => (
          <li key={f.commandId ?? f.n} className={`voice-followup is-${f.status}${f.kind === "delegation" ? " is-delegation" : ""}`}>
            {f.kind === "delegation" ? (
              <p className="voice-followup-title" title={f.target ? `target agent ${f.target}` : undefined}>{delegationLabel(f.targetName ?? f.target, f.title)}</p>
            ) : null}
            <p className="voice-followup-head">
              <span className={`voice-flag is-followup is-${f.status}`}>#{f.n} {FOLLOWUP_WORD[f.status]}</span>
              {" "}{f.lane ?? "batch"} lane{f.model ? ` · ${f.model}` : ""}{f.perm ? ` · ${permText(f.perm)}` : ""}
              {f.seconds !== undefined ? ` · ${f.status === "running" ? "running for" : "took"} ${formatDuration(f.seconds)}` : ""}
              {f.afterAnswerSeconds !== undefined ? ` · spoken ${formatDuration(f.afterAnswerSeconds)} after the quick answer` : ""}
            </p>
            {f.plan && f.plan !== f.title ? <blockquote><span className="hub-label">{f.kind === "delegation" ? "Brief sent" : "Handed off"}</span><p>{f.plan}</p></blockquote> : null}
            {f.replyText ? <blockquote><span className="hub-label">{f.kind === "delegation" ? "Agent said (result)" : "Agent said (follow-up)"}</span><p>{f.replyText}</p></blockquote> : null}
            {f.error ? <p className="hub-note">{f.error}</p> : null}
            <dl className="voice-ids">
              {f.commandId ? <div><dt>command</dt><dd><CopyRef value={f.commandId} /></dd></div> : null}
              {f.briefId ? <div><dt>brief</dt><dd><CopyRef value={f.briefId} /></dd></div> : null}
              {f.replyKey ? <div><dt>reply</dt><dd><CopyRef value={f.replyKey} /></dd></div> : null}
            </dl>
          </li>
        ))}
      </ol>
    </section>
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
              {memo.conv ? <> · <ConvChips conv={memo.conv} /></> : null}
              {memo.lane ? <> · <LaneChip lane={memo.lane} reason={memo.laneReason} /></> : null}
              {memo.late ? <> · <LateChip /></> : null}
              {memo.detached ? <> · <DetachedChip /></> : null}
              {memo.followup ? <> · <FollowupChip followup={memo.followup} /></> : null}
              {memo.audio ? <> · <span className={`voice-level${memo.audio.silent ? " is-silent" : ""}`} title="loudest sample of the recording, measured before transcribing">{audioChip(memo.audio)}</span></> : null}
              {captureChip(memo.capture) ? <> · <span className={`voice-level${memo.capture?.silent ? " is-silent" : ""}`} title="level the device's recorder reported">{captureChip(memo.capture)}</span></> : null}
            </p>
          </div>
        </div>
        <dl className="voice-ids">
          <div><dt>memo</dt><dd><CopyRef value={memo.memoId} /></dd></div>
          {memo.escalatedFromCommandId ? <div><dt>1st cmd</dt><dd><CopyRef value={memo.escalatedFromCommandId} /></dd></div> : null}
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

      {memo.cancelled ? (
        <div className="voice-note is-cancelled" role="status">
          <span className="hub-label">Cancelled {memo.cancelled.afterDispatch ? "after" : "before"} dispatch</span>
          <p>
            {memo.cancelled.afterDispatch
              ? "The command had already been published, so the agent may still run: nothing is undone. Its reply will not be spoken or mirrored."
              : "Nothing was sent to an agent."}
            {" "}Not an error. It is only retried by an explicit <code>mise run memo:retry</code>.
          </p>
        </div>
      ) : null}

      {memo.escalated && !memo.cancelled && memo.status !== "failed" ? (
        <div className="voice-note is-escalated" role="status">
          <span className="hub-label">Escalated to the batch lane</span>
          <p>
            {escalationText(memo)}
            {memo.status === "complete" ? " The reply was spoken as a late reply." : " It is not failed: the reply will be spoken as a late reply when the batch turn finishes."}
          </p>
        </div>
      ) : null}

      {memo.detached && !memo.cancelled && memo.status !== "failed" ? (
        <div className="voice-note is-detached" role="status">
          <span className="hub-label">Detached at the wall clock</span>
          <p>
            The interactive turn ran past the gateway&apos;s {memo.detach?.elapsedSeconds !== undefined ? `${Math.round(memo.detach.elapsedSeconds)} s` : "300 s"} limit
            and was let run on with its slot released: no kill, no batch re-run.
            {memo.status === "complete" ? " The reply was spoken as a late reply." : ` The car was told it will be called back; the reply is spoken late (the gateway stops it at ${memo.detach?.ceilingSeconds ?? 2700} s).`}
          </p>
        </div>
      ) : null}

      {memo.transcript || memo.replyText ? (
        <div className="voice-text">
          {memo.transcript ? <blockquote><span className="hub-label">Heard</span><p>{memo.transcript}</p></blockquote> : null}
          {memo.replyText ? <blockquote><span className="hub-label">{memo.routed?.fast ? "Fast desk said" : `Agent said${memo.background ? " (quick answer)" : memo.late ? " (late reply)" : ""}`}</span><p>{memo.replyText}</p></blockquote> : null}
        </div>
      ) : null}

      <FollowUps memo={memo} />

      <WhileWaiting memo={memo} />

      <ol className="voice-hops">
        {memo.hops.map((hop, i) => (
          <HopRow key={hop.id} hop={hop} last={i === memo.hops.length - 1} now={now} basis={lastAt} watcher={watcher} lane={memo.lane} />
        ))}
      </ol>
    </section>
  );
}

const TIMING: { key: keyof MemoTiming; label: string; title: string }[] = [
  { key: "ackSeconds", label: "ack", title: "the car's instant acknowledgement started (device clock)" },
  { key: "routedSeconds", label: "fast desk decided", title: "the fast conversation desk decided the turn (audio.memo.routed): a fast answer, or the agent path" },
  { key: "heardEchoSeconds", label: "heard echo", title: "the car said what it heard" },
  { key: "firstProgressSeconds", label: "first progress", title: "the agent wrote its first line while working" },
  { key: "firstNarrationSeconds", label: "first narration", title: "the watcher spoke a progress line for the car" },
  { key: "progressPlayedSeconds", label: "progress played", title: "the car started playing a progress update" },
  { key: "firstChunkSeconds", label: "first chunk up", title: "the reply's first sentence-chunk was uploaded (a reply long enough to be spoken in chunks)" },
  { key: "replyUpSeconds", label: "reply up", title: "the whole reply was up: the full reply file (a one-file reply: its only chunk), which the phone plays" },
  { key: "replyPlayedSeconds", label: "reply played", title: "the car started playing the reply" }
];

/** Time to first response once the agent finished, and the car's own lag behind the audio it could play. */
const AFTER_AGENT: { key: keyof MemoTiming; label: string; title: string }[] = [
  { key: "agentToFirstChunkSeconds", label: "first chunk up", title: "agent finished -> the first chunk was uploaded" },
  { key: "agentToReplySeconds", label: "reply up", title: "agent finished -> the full reply file was uploaded" },
  { key: "agentToCarSeconds", label: "car speaking", title: "agent finished -> the car started the reply" },
  { key: "carLagSeconds", label: "car lag", title: "first audio available (first chunk, else the full reply) -> the pad's started beacon, both server clocks" }
];

/** "+0.6 s" / "−0.4 s": seconds relative to the upload (the ack can start before the upload lands). */
function signed(seconds: number): string {
  return `${seconds < 0 ? "\u2212" : "+"}${formatLatency(Math.abs(seconds) * 1000)}`;
}

/** What the driver heard before the answer: the timing of each first sound, the agent's own progress lines (and which of
 * them were spoken in the car), and every decision of the car's speech queue. Nothing here when there was none of it. */
function WhileWaiting({ memo }: { memo: MemoDetail }) {
  const progress = memo.progress ?? [];
  const narrations = memo.narrations ?? [];
  const speech = memo.speech ?? [];
  const chunks = memo.chunks ?? [];
  const timing = TIMING.filter((t) => memo.timing?.[t.key] !== undefined);
  const after = AFTER_AGENT.filter((t) => memo.timing?.[t.key] !== undefined);
  if (!progress.length && !narrations.length && !speech.length && !chunks.length && !after.length) return null;
  const spoken = new Map(narrations.filter((n) => n.seq !== undefined).map((n) => [n.seq!, n]));
  const current = progress.filter((p) => !p.superseded);
  return (
    <section className="voice-waiting" aria-label="While the driver waited">
      {timing.length ? (
        <p className="voice-timing">
          <span className="hub-label">Since upload</span>
          {timing.map((t) => (
            <span key={t.key} className="voice-timing-item" title={t.title}>{t.label} <strong>{signed(memo.timing![t.key]!)}</strong></span>
          ))}
        </p>
      ) : null}
      {after.length ? (
        <p className="voice-timing">
          <span className="hub-label">{memo.routed?.fast ? "After the fast model answered" : "After the agent finished"}</span>
          {after.map((t) => (
            <span key={t.key} className="voice-timing-item" title={t.title}>{t.label} <strong>{signed(memo.timing![t.key]!)}</strong></span>
          ))}
        </p>
      ) : null}
      {chunks.length ? (
        <p className="voice-timing">
          <span className="hub-label">{chunks[0].of === 1 ? "Reply spoken as one file" : `Reply in ${chunks[0].of} chunks`}</span>
          {chunks.map((c) => (
            <span key={c.eventId} className="voice-timing-item" title={`${c.key ?? ""}${c.text ? `: ${c.text}` : ""}`}>
              #{c.n} <strong>{clockTime(c.at)}</strong>{c.ttsSeconds !== undefined ? ` · tts ${c.ttsSeconds}s` : ""}
            </span>
          ))}
        </p>
      ) : null}
      {progress.length ? (
        <div className="voice-progress">
          <span className="hub-label">The agent said, while working ({current.length}{narrations.length ? `, ${narrations.length} spoken in the car` : ""})</span>
          <ol>
            {progress.map((p) => {
              const said = !p.superseded ? spoken.get(p.seq) : undefined;
              return (
                <li key={p.eventId} className={p.superseded ? "is-superseded" : said ? "is-spoken" : undefined}>
                  <time dateTime={p.at}>{clockTime(p.at)}</time>
                  <span className="voice-progress-at">{p.elapsedSeconds !== undefined ? `${Math.round(p.elapsedSeconds)}s` : `#${p.seq}`}</span>
                  <span className="voice-progress-text">{p.text}</span>
                  {said ? <span className="voice-flag is-spoken" title={said.key}>spoken {clockTime(said.at)}{said.ttsSeconds !== undefined ? ` · tts ${said.ttsSeconds}s` : ""}</span> : null}
                  {p.superseded ? <span className="voice-flag" title="the interactive turn that timed out">1st turn</span> : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
      {speech.length ? (
        <details className="voice-raw">
          <summary>Car speech queue ({speech.length} decisions)</summary>
          <ul className="voice-attempts" aria-label="Car speech decisions">
            {speech.map((d) => (
              <li key={d.eventId} className={d.recording ? "is-recording" : undefined}>
                <time dateTime={d.deviceAt ?? d.at}>{clockTime(d.deviceAt ?? d.at)}</time> {d.utterance} {d.decision}
                {d.reason ? ` · ${d.reason}` : ""}{d.mic && d.mic !== "idle" ? ` · mic ${d.mic}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** "The interactive turn timed out after 20s (lane limit 20s); the same prompt was re-dispatched on the batch lane, which has no wall clock." */
function escalationText(memo: MemoDetail): string {
  const t = memo.hops.find((h) => h.id === "agent_done")?.error?.timeout;
  const after = t?.elapsedSeconds !== undefined ? ` after ${Math.round(t.elapsedSeconds)}s` : "";
  const limit = t?.limitSeconds !== undefined ? ` (limit ${t.limitSeconds}s)` : "";
  return `The interactive turn timed out${after}${limit}; the watcher re-dispatched the same prompt on the batch lane, in the same session.`;
}

// Hops the inbox watcher is responsible for: if it is down, that is why they are stuck.
const WATCHER_HOPS = new Set(["received", "transcribed", "dispatched", "escalated", "replied"]);

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
          {hop.reply?.late ? <LateChip /> : null}
          {hop.at && hop.events.length ? <time className="voice-hop-time" dateTime={hop.at} title={hop.at}>{clockTime(hop.at)}</time> : null}
          {hop.sinceMs !== undefined ? <span className="voice-hop-lat" title="since the previous hop">+{formatLatency(hop.sinceMs)}</span> : null}
          {waited !== undefined ? (
            <span className={`voice-hop-lat is-${hop.status}`}>
              waiting {formatLatency(waited * 1000)} of expected {formatLatency(hop.budgetSeconds * 1000)}
            </span>
          ) : null}
        </div>
        {hop.detail ? <p className="voice-hop-detail">{hop.detail}</p> : null}
        {phoneCopyText(hop.reply) ? (
          <p className="voice-hop-detail" title="Exactly one of the car and the phone speaks a reply: a paired phone plays through the car's speakers (the same reply twice, or into a recording)">
            {phoneCopyText(hop.reply)}
          </p>
        ) : null}
        {hop.routed?.attemptLog?.length ? (
          <ul className="voice-attempts" aria-label="Fast-model ladder attempts">
            {hop.routed.attemptLog.map((a, i) => <li key={i}>{attemptText(a, i)}</li>)}
          </ul>
        ) : null}
        {hop.routed?.title ? <p className="voice-hop-detail">Draft: {hop.routed.title}</p> : null}
        {hop.reply?.earshotTextKey ? (
          <p className="voice-hop-detail voice-sidecar" title="The phone gets the full reply text as a sibling object of the reply audio, uploaded before it">
            Earshot text sidecar <CopyRef value={hop.reply.earshotTextKey} />
          </p>
        ) : null}
        {live && (hop.id === "agent_started" || hop.id === "batch_started") && lane && laneQueueText(lane, watcher?.lanes?.[lane]) ? (
          <p className="voice-hop-detail">Gateway: {laneQueueText(lane, watcher?.lanes?.[lane])}</p>
        ) : null}
        {live && watcher && watcher.state !== "running" && WATCHER_HOPS.has(hop.id) ? (
          <p className="voice-hop-detail"><strong>Cause: {watcher.detail}.</strong></p>
        ) : null}
        {hop.status === "missing" ? <p className="voice-hop-detail">No fact for this hop, though later hops happened.</p> : null}
        {hop.error ? (
          <div className={`voice-error${hop.status === "timed_out" ? " is-soft" : ""}`}>
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Glyph, formatDuration } from "../hub/ui";
import type { Signal, Source } from "../hub/types";
import { NOISE_MINUTES, describeCron, isFrequent } from "./cron";
import { postAction } from "./candybar-api";
import { applyEvent, byTime, emptyModel, fromSnapshot, markSkipped, setNoise, type Fire, type Model } from "./schedule-model";
import { subscribeSchedule, type StreamStatus } from "./schedule-stream";
import type { SchedulePayload } from "./types";

// The Schedule view: today's fires, oldest at the top. Past rows are greyed with their result, the next fire is
// solid, upcoming rows count down, and the list follows the day as it advances. One /schedule snapshot per local
// day, then Candybar's stream patches it in place; a `reset` (Candybar restarted, or we fell too far behind) reloads
// the snapshot once. Upcoming rows can be skipped (this fire, or the rest of the candybar's day) and any row's
// candybar can be marked noise; Candybar applies it and its stream says so (the row also updates at once).

const PAST_STEP = 40;
const UPCOMING_STEP = 150;
const SNAPSHOT_RETRY_MS = 5_000;

const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const HOUR = new Intl.DateTimeFormat("en-US", { hour: "numeric" });
const ZONE = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" });
const zoneName = (t: number) => ZONE.formatToParts(t).find((p) => p.type === "timeZoneName")?.value ?? "";

/** The browser's local day, so a DST day is 23 or 25 h long. */
function localDay(now: number): { from: string; to: string } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

const isNoisy = (f: Fire) => f.noise || isFrequent(f.schedule);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function countdown(t: number, now: number): string {
  const s = (t - now) / 1000;
  return s <= 0 ? "firing" : `in ${formatDuration(s)}`;
}

function fireSignal(f: Fire): Signal | undefined {
  if (f.state !== "past") return f.skipped ? "quiet" : undefined;
  if (f.running) return "working";
  if (f.lastResult === "success") return "cleared";
  if (f.lastResult === "fail") return "broken";
  return f.skipped ? "quiet" : "unknown";
}

function FireStatus({ f, next, now }: { f: Fire; next: boolean; now: number }) {
  if (f.skipped) return <span className="cb-fire-status is-skipped">skipped</span>;
  if (f.state !== "past") return <span className={`cb-fire-status is-count${next ? " is-next" : ""}`}>{countdown(f.t, now)}</span>;
  if (f.running) return <span className="cb-fire-status is-running">running</span>;
  if (f.lastResult === "success") return <span className="cb-fire-status is-success">passed</span>;
  if (f.lastResult === "fail") return <span className="cb-fire-status is-fail">failed</span>;
  return <span className="cb-fire-status is-none" title="no recorded run for this fire (coalesced, disabled, or still in flight)">no run</span>;
}

type FireAction = "skip" | "rest" | "noise";

/** Skip (this fire), Skip rest of day and Mark noise. Beside the cron on hover or focus on desktop; behind a small
 *  trailing button on touch and narrow screens, where there is no hover. */
function FireActions({ f, open, busy, onToggle, onAct }: {
  f: Fire;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onAct: (action: FireAction) => void;
}) {
  const canSkip = f.state !== "past" && !f.skipped;
  const label = `${f.name} at ${CLOCK.format(f.t)}`;
  return (
    <>
      <button
        type="button"
        className="cb-fire-more"
        aria-expanded={open}
        aria-label={`Actions for ${label}`}
        onClick={onToggle}
      >
        <span aria-hidden="true">{open ? "×" : "⋯"}</span>
      </button>
      <div className="cb-fire-actions" role="group" aria-label={`Actions for ${label}`}>
        {canSkip ? <button type="button" className="cb-fa" disabled={busy} onClick={() => onAct("skip")}>Skip</button> : null}
        {canSkip ? <button type="button" className="cb-fa" disabled={busy} onClick={() => onAct("rest")}>Skip rest of day</button> : null}
        <button type="button" className="cb-fa" disabled={busy} onClick={() => onAct("noise")}>{f.noise ? "Unmark noise" : "Mark noise"}</button>
      </div>
    </>
  );
}

function FireRow({ f, next, now, rowRef, onOpen, busy, onAct }: {
  f: Fire;
  next: boolean;
  now: number;
  rowRef?: (el: HTMLLIElement | null) => void;
  onOpen: (candybarId: string) => void;
  busy: boolean;
  onAct: (f: Fire, action: FireAction) => void;
}) {
  const signal = fireSignal(f);
  const words = describeCron(f.schedule);
  const [menu, setMenu] = useState(false);
  return (
    <li
      ref={rowRef}
      className={`cb-fire is-${f.state}${next ? " is-next" : ""}${f.lastResult === "fail" ? " is-fail" : ""}${f.skipped ? " is-skipped" : ""}${menu ? " is-menu" : ""}`}
      aria-current={next ? "time" : undefined}
    >
      <time className="cb-fire-time" dateTime={new Date(f.t).toISOString()}>{CLOCK.format(f.t)}</time>
      <span className="cb-fire-sig">{signal ? <Glyph signal={signal} /> : null}</span>
      <a
        className="cb-fire-name"
        href={`?tab=definitions&open=${encodeURIComponent(f.candybarId)}`}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault(); // stay in the page: a reload would drop the day's snapshot and the stream
          onOpen(f.candybarId);
        }}
      >
        {f.name}
      </a>
      <span className="cb-fire-cron" title={f.schedule}>{words ?? f.schedule}</span>
      <FireStatus f={f} next={next} now={now} />
      <FireActions f={f} open={menu} busy={busy} onToggle={() => setMenu((m) => !m)} onAct={(a) => { setMenu(false); onAct(f, a); }} />
    </li>
  );
}

type Props = {
  now: number;
  q: string;
  searchText: string;
  onSearch: (text: string) => void;
  showNoise: boolean;
  onShowNoise: (show: boolean) => void;
  onSource: (source: Source | undefined) => void;
  onOpenDefinition: (candybarId: string) => void;
};

type Load = { status: "loading" | "ok" | "error"; error?: string };

export function ScheduleView({ now, q, searchText, onSearch, showNoise, onShowNoise, onSource, onOpenDefinition }: Props) {
  const day = new Date(now).toDateString();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the window moves only when the local day does
  const dayWindow = useMemo(() => localDay(now), [day]);
  const modelRef = useRef<Model>(emptyModel());
  const [version, setVersion] = useState(0);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [stream, setStream] = useState<{ status: StreamStatus; detail?: string }>({ status: "connecting" });
  const [pastShown, setPastShown] = useState(PAST_STEP);
  const [upcomingShown, setUpcomingShown] = useState(UPCOMING_STEP);
  const [follow, setFollow] = useState(true);
  const nextEl = useRef<HTMLLIElement | null>(null);
  const controls = useRef<{ bump: () => void; refetch: () => void }>({ bump: () => undefined, refetch: () => undefined });
  const [notice, setNotice] = useState<string>();
  const [busyKey, setBusyKey] = useState<string>();
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();
  const scrolledOnce = useRef(false);
  /** Scroll events before this instant are our own scrollIntoView, not the operator's. */
  const ourScrollUntil = useRef(0);

  useEffect(() => {
    let alive = true;
    let loaded = false;
    let loading = false;
    let again = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    let ctl: AbortController | undefined;
    const pending: Array<[string, unknown]> = [];
    modelRef.current = emptyModel();
    setLoad({ status: "loading" });
    setVersion((v) => v + 1);
    // A new day starts at its own "now", not where yesterday's list was expanded or scrolled.
    setPastShown(PAST_STEP);
    setUpcomingShown(UPCOMING_STEP);
    scrolledOnce.current = false;

    // Bursts arrive at each minute boundary (50+ events in ~0.1 s); render once per frame, not once per event.
    const bump = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (alive) setVersion((v) => v + 1);
      });
    };

    async function readSnapshot() {
      if (loading) {
        again = true;
        return;
      }
      loading = true;
      again = false;
      clearTimeout(retry);
      // Everything heard before this read is older than the snapshot it returns, so only later events are kept;
      // this also bounds the buffer while Candybar keeps refusing the snapshot.
      pending.length = 0;
      ctl = new AbortController();
      try {
        const res = await fetch(`/api/modules/candybar/schedule?${new URLSearchParams(dayWindow)}`, { cache: "no-store", signal: ctl.signal });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        }
        const model = fromSnapshot((await res.json()) as SchedulePayload);
        if (!alive) return;
        // Events that arrived while the snapshot was read are applied on top; each is absolute state.
        let refetch = false;
        for (const [name, data] of pending.splice(0)) refetch = applyEvent(model, name, data) === "refetch" || refetch;
        modelRef.current = model;
        loaded = true;
        setLoad({ status: "ok" });
        bump();
        if (refetch) again = true;
      } catch (err) {
        if (!alive || ctl?.signal.aborted) return;
        setLoad({ status: "error", error: err instanceof Error ? err.message : String(err) });
        retry = setTimeout(() => void readSnapshot(), SNAPSHOT_RETRY_MS);
      } finally {
        loading = false;
        if (alive && again) void readSnapshot();
      }
    }

    controls.current = { bump, refetch: () => void readSnapshot() };

    const close = subscribeSchedule({
      ...dayWindow,
      onStatus: (status, detail) => alive && setStream({ status, detail }),
      onEvent: (name, data) => {
        if (!loaded) {
          pending.push([name, data]);
          if (name === "reset") pending.length = 0;
          return;
        }
        if (applyEvent(modelRef.current, name, data) === "refetch") {
          loaded = false;
          void readSnapshot();
        } else bump();
      }
    });
    void readSnapshot();

    return () => {
      alive = false;
      close();
      ctl?.abort();
      clearTimeout(retry);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [dayWindow]);

  useEffect(() => {
    onSource({
      name: "stream",
      value: stream.status === "live" ? "live" : stream.status,
      down: stream.status === "reconnecting",
      detail: stream.detail
    });
  }, [stream, onSource]);
  useEffect(() => () => onSource(undefined), [onSource]);

  // ---------- row actions ----------

  const fail = useCallback((text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(undefined), 8_000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const act = useCallback(async (f: Fire, action: FireAction) => {
    if (action === "rest" && !window.confirm(`Skip every remaining fire of ${f.name} on the day of its ${CLOCK.format(f.t)} fire?\n\nCandybar applies it to that day in the candybar's own time zone.`)) return;
    setBusyKey(f.key);
    setNotice(undefined);
    const r = action === "skip"
      ? await postAction(f.candybarId, "skip", { fireTime: f.fireTime })
      : action === "rest"
        ? await postAction(f.candybarId, "skip-rest-of-day", { fireTime: f.fireTime })
        : await postAction(f.candybarId, "noise", { noise: !f.noise });
    setBusyKey(undefined);
    if (!r.ok) {
      const what = action === "skip" ? "Skip" : action === "rest" ? "Skip rest of day" : f.noise ? "Unmark noise" : "Mark noise";
      fail(`${what} failed for ${f.name}: ${r.error}${r.status ? ` (${r.status})` : ""}`);
      return;
    }
    // The stream says the same in a moment; the row need not wait for it.
    if (action === "skip") markSkipped(modelRef.current, f.key);
    else if (action === "noise") setNoise(modelRef.current, f.candybarId, !f.noise);
    if (action === "rest") controls.current.refetch();
    else controls.current.bump();
  }, [fail]);

  // ---------- what to show ----------

  const all = useMemo(() => [...modelRef.current.fires.values()].sort(byTime), [version]);
  const { visible, hidden, noisyFailures } = useMemo(() => {
    const needle = q.toLowerCase();
    const searched = needle ? all.filter((f) => f.name.toLowerCase().includes(needle) || f.schedule.includes(needle)) : all;
    if (showNoise) return { visible: searched, hidden: 0, noisyFailures: [] };
    // A noisy candybar failing every few minutes would flood the timeline, so its fires stay hidden, but its failures
    // are counted above the list: hidden never means silent.
    const shown: Fire[] = [];
    const failures = new Map<string, number>();
    for (const f of searched) {
      if (!isNoisy(f)) shown.push(f);
      else if (f.lastResult === "fail") failures.set(f.name, (failures.get(f.name) ?? 0) + 1);
    }
    const noisyFailures = [...failures].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { visible: shown, hidden: searched.length - shown.length, noisyFailures };
  }, [all, q, showNoise]);

  // The next fire to show solid: Candybar's `current` when it is visible, else the first visible row still to come.
  const nextIdx = useMemo(() => {
    const current = visible.findIndex((f) => f.state === "current");
    return current >= 0 ? current : visible.findIndex((f) => f.state !== "past" && !f.skipped);
  }, [visible]);
  const next = nextIdx >= 0 ? visible[nextIdx] : undefined;
  const pivot = nextIdx >= 0 ? nextIdx : visible.length;
  const start = Math.max(0, pivot - pastShown);
  const end = Math.min(visible.length, pivot + upcomingShown);
  const rows = visible.slice(start, end);

  const done = visible.filter((f) => f.state === "past");
  const failed = done.filter((f) => f.lastResult === "fail").length;
  const toCome = visible.length - done.length;

  // ---------- following the day ----------

  const scrollToNext = useCallback((smooth: boolean) => {
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    ourScrollUntil.current = Date.now() + (smooth && !reduce ? 1_500 : 200);
    nextEl.current?.scrollIntoView({ block: "center", behavior: smooth && !reduce ? "smooth" : "auto" });
  }, []);
  useEffect(() => {
    if (!follow || !next || load.status !== "ok") return;
    scrollToNext(scrolledOnce.current);
    scrolledOnce.current = true;
  }, [follow, next?.key, load.status, scrollToNext]); // eslint-disable-line react-hooks/exhaustive-deps

  // Any scroll that is not our own (wheel, scrollbar drag, keys, find-in-page, a focus jump) stops the follow;
  // "Follow now" resumes it.
  useEffect(() => {
    if (!follow) return;
    const onScroll = () => {
      if (Date.now() > ourScrollUntil.current) setFollow(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [follow]);

  // ---------- render ----------

  const zone = zoneName(now);
  const statement =
    load.status !== "ok"
      ? load.status === "error" ? "The day's schedule could not be read." : "Reading today's schedule…"
      : !visible.length
        ? hidden ? `Nothing outside the noise today (${plural(hidden, "noisy fire")} hidden).` : "No fires today."
        : `Today: ${plural(done.length, "fire")} done${failed ? `, ${failed} failed` : ""}; ${toCome} to come.${next ? ` Next: ${next.name} at ${CLOCK.format(next.t)}.` : " Nothing left today."}`;

  // Dividers break on the real hour (UTC-hour buckets), so the repeated 1 AM of a fall-back night gets two.
  let hourBucket = NaN;
  const items: React.ReactNode[] = [];
  for (const f of rows) {
    const bucket = Math.floor(f.t / 3_600_000);
    if (bucket !== hourBucket) {
      hourBucket = bucket;
      items.push(<li key={`h-${bucket}`} className="cb-hour" aria-hidden="true">{HOUR.format(f.t)} {zoneName(f.t)}</li>);
    }
    const isNext = f === next;
    items.push(
      <FireRow key={f.key} f={f} next={isNext} now={now} onOpen={onOpenDefinition} busy={busyKey === f.key} onAct={act} rowRef={isNext ? (el) => { nextEl.current = el; } : undefined} />
    );
  }

  return (
    <>
      <div className="hub-lede">
        <p className="hub-statement" aria-live="polite">{statement}</p>
        {load.status === "error" ? (
          <p className="hub-error" role="status"><span className="hub-label">Candybar</span>{load.error} Retrying every {SNAPSHOT_RETRY_MS / 1000}s.</p>
        ) : null}
        {noisyFailures.length ? (
          <p className="hub-error" role="status">
            <span className="hub-label">Noise</span>
            {noisyFailures.slice(0, 3).map(([name, n]) => `${name} failed ${plural(n, "time")}`).join(", ")}
            {noisyFailures.length > 3 ? `, and ${plural(noisyFailures.length - 3, "other noisy candybar")}` : ""} today; their fires are hidden.
          </p>
        ) : null}
        {notice ? <p className="hub-error" role="alert"><span className="hub-label">Failed</span>{notice}</p> : null}
        {stream.status === "reconnecting" ? (
          <p className="hub-error" role="status"><span className="hub-label">Stream</span>{stream.detail ?? "Reconnecting."} The rows shown may be behind.</p>
        ) : null}
      </div>

      <div className="cb-controls">
        <div className="cb-controls-end">
          <input
            type="search"
            className="cb-search"
            placeholder="Filter by name or cron"
            aria-label="Filter today's fires"
            value={searchText}
            onChange={(e) => onSearch(e.target.value)}
          />
          <label className="cb-check">
            <input type="checkbox" checked={showNoise} onChange={(e) => onShowNoise(e.target.checked)} />
            Show noise
            {!showNoise && hidden ? <span className="cb-check-count">{hidden} hidden</span> : null}
          </label>
        </div>
        <button type="button" className="cb-follow" aria-pressed={follow} onClick={() => { setFollow(true); scrollToNext(true); }} disabled={!next}>
          {follow ? "Following now" : "Follow now"}
        </button>
      </div>

      {load.status !== "ok" && !all.length ? (
        <div className="hub-placeholder">
          <span className="hub-label">{load.status === "error" ? "No data" : "Loading"}</span>
          <p>{load.status === "error" ? `GET /api/modules/candybar/schedule failed: ${load.error}` : "Reading today's schedule from Candybar…"}</p>
        </div>
      ) : visible.length ? (
        <>
          <div className="cb-fire-columns" aria-hidden="true">
            <span>{zone}</span>
            <span />
            <span>Candybar</span>
            <span>Schedule</span>
            <span>Result · countdown</span>
            <span className="cb-fire-colmore" />
          </div>
          {start > 0 ? (
            <button type="button" className="cb-more" onClick={() => setPastShown((n) => n + PAST_STEP * 5)}>
              Show earlier fires ({start} more)
            </button>
          ) : null}
          <ol className="cb-fires" aria-label="Today's fires">{items}</ol>
          {end < visible.length ? (
            <button type="button" className="cb-more" onClick={() => setUpcomingShown((n) => n + UPCOMING_STEP * 2)}>
              Show later fires ({visible.length - end} more)
            </button>
          ) : null}
        </>
      ) : (
        <div className="hub-placeholder">
          <span className="hub-label">Empty view</span>
          <p>{q ? `No fire today matches “${q}”.` : hidden ? `Every fire today is noise; tick “Show noise” to see ${plural(hidden, "fire")}.` : "Candybar has nothing scheduled today."}</p>
        </div>
      )}
      <p className="cb-note">
        Times are {zone}. Noise is the explicit collection plus anything firing more often than every {NOISE_MINUTES} min; hidden noisy failures are counted above the list.
      </p>
    </>
  );
}

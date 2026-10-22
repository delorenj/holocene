import type { Signal } from "../hub/types";
import type { AudioLevel, CaptureLevel, Lane, LaneStatus, HopStatus, MemoStatus, MemoSummary, ReplyInfo } from "./types";

export const HOP_SIGNAL: Record<HopStatus, Signal> = {
  ok: "cleared", failed: "broken", waiting: "working", stuck: "stuck", pending: "quiet", missing: "unknown",
  // Neither is an error: the hourglass is the turn that ran out of time, the dash is a memo someone stopped.
  timed_out: "stuck", cancelled: "quiet"
};
export const MEMO_SIGNAL: Record<MemoStatus, Signal> = { complete: "cleared", failed: "broken", running: "working", stuck: "stuck", cancelled: "quiet" };
export const HOP_WORD: Record<HopStatus, string> = {
  ok: "Done", failed: "Failed", waiting: "Waiting", stuck: "Stuck", pending: "Not reached", missing: "Not recorded",
  timed_out: "Timed out", cancelled: "Cancelled"
};

/** dispatched fact lane_reason of a memo re-dispatched on the batch lane after its interactive turn timed out. */
export const ESCALATED_REASON = "turn_timeout_escalated";

/** "max -73 dBFS · silent" · "max -8 dBFS · audible": the recording's loudest sample, as the watcher measured it. */
export function audioChip(a: AudioLevel): string {
  return `max ${Math.round(a.maxDbfs)} dBFS · ${a.silent ? "silent" : "audible"}`;
}

/** "device heard peak -71 dBFS" · undefined when the pad reported nothing. */
export function captureChip(c: CaptureLevel | undefined): string | undefined {
  if (!c) return undefined;
  const bits = [c.peakDbfs !== undefined ? `peak ${Math.round(c.peakDbfs)} dBFS` : undefined, c.rmsDbfs !== undefined ? `window avg ${Math.round(c.rmsDbfs)} dBFS` : undefined].filter(Boolean);
  return bits.length ? `device heard ${bits.join(", ")}` : undefined;
}

/** 240 ms · 2.1 s · 46 s · 12m · 1h 06m */
export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${h}h`;
}

export function clockTime(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "–";
  return new Date(t).toLocaleTimeString([], { hour12: false });
}

export function dayTime(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "–";
  const d = new Date(t);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? d.toLocaleTimeString([], { hour12: false }) : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour12: false })}`;
}

/** Running memos keep counting in the browser between polls. */
export function liveTotal(memo: Pick<MemoSummary, "status" | "startedAt" | "totalSeconds">, now: number): number {
  if (memo.status !== "running" && memo.status !== "stuck") return memo.totalSeconds;
  const start = Date.parse(memo.startedAt);
  return Number.isFinite(start) ? Math.max(memo.totalSeconds, (now - start) / 1000) : memo.totalSeconds;
}

export function statement(memos: MemoSummary[]): string {
  if (!memos.length) return "No voice memos in the event collection yet.";
  const count = (s: MemoStatus) => memos.filter((m) => m.status === s).length;
  const parts: string[] = [`${memos.length} recent ${memos.length === 1 ? "memo" : "memos"}.`];
  if (count("stuck")) parts.push(`${count("stuck")} stuck.`);
  if (count("failed")) parts.push(`${count("failed")} failed.`);
  if (count("running")) parts.push(`${count("running")} in flight.`);
  const escalated = memos.filter((m) => m.escalated && (m.status === "running" || m.status === "stuck")).length;
  if (escalated) parts.push(`${escalated} escalated to the batch lane.`);
  const detached = memos.filter((m) => m.detached && (m.status === "running" || m.status === "stuck")).length;
  if (detached) parts.push(`${detached} detached, running on.`);
  const background = memos.filter((m) => m.followup?.status === "running").length;
  if (background) parts.push(`${background} answered, follow-up running.`);
  if (count("complete")) parts.push(`${count("complete")} complete.`);
  if (count("cancelled")) parts.push(`${count("cancelled")} cancelled.`);
  return parts.join(" ");
}

/** "interactive lane: 1/2 in flight, 0 queued" · "batch lane: 4/4 in flight, 17 queued" · undefined when never probed. */
export function laneQueueText(lane: Lane, status: LaneStatus | undefined): string | undefined {
  if (!status || status.pulling === undefined) return undefined;
  if (status.draining) {
    const busy = status.inFlight ? `, ${status.inFlight} in flight finishing` : "";
    const why = status.gatewayLabel ?? "gateway restarting (draining)";
    return `${lane} lane: ${why}, ${status.queued ?? 0} queued; they run when the gateway takes turns again${busy}`;
  }
  if (!status.pulling) return `${lane} lane: nobody is pulling its consumer`;
  const slots = status.slots !== undefined ? `/${status.slots}` : "";
  return `${lane} lane: ${status.inFlight ?? 0}${slots} in flight, ${status.queued ?? 0} queued`;
}

type Lanes = { interactive?: LaneStatus; batch?: LaneStatus } | undefined;
const pausedLane = (lanes: Lanes) => (lanes?.interactive?.draining ? lanes.interactive : lanes?.batch?.draining ? lanes.batch : undefined);

/** "Gateway restarting (draining)" · "Gateway stopping (draining)" · "Gateway paused for maintenance (draining)" · "Gateway starting". */
export function gatewayPauseLabel(lanes: Lanes): string {
  const label = pausedLane(lanes)?.gatewayLabel ?? "gateway restarting (draining)";
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The watcher's sentence for why nothing is pulled, e.g. "Gateway stopping (draining), memo queued; it runs when ...". */
export function gatewayPauseSentence(lanes: Lanes): string {
  const text = pausedLane(lanes)?.gateway ?? "gateway restarting (draining), memo queued; it runs when the gateway is back";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The /voice line for the phone copy: why it was left out, or why it was sent (null: nothing to say). */
export function phoneCopyText(r: ReplyInfo | undefined): string | null {
  if (!r) return null;
  if (r.earshotReason === "late_drop" && r.earshotKey) {
    const l = r.phoneLate;
    return `Mirrored to the phone late: the first Earshot drops failed and no car claimed the reply, then the watcher's background retry landed it${
      l?.afterReleaseSeconds !== undefined ? ` ${Math.round(l.afterReleaseSeconds)} s after the release` : ""}${l?.rounds ? ` (round ${l.rounds})` : ""}.`;
  }
  if (r.earshotSkipped === "no_answer") {
    return "Not mirrored to the phone: the upload proxy could not be asked who speaks it for minutes, so it was left to the car (which speaks a reply only with the proxy's yes).";
  }
  if (r.earshotSkipped) {
    const why = r.earshotSkipped === "car_spoke" ? "started (or finished) it"
      : r.earshotSkipped === "car_holds" ? "still held it, live, minutes after it was up"
      : r.earshotSkipped === "car_live" ? "was connected and spoke it itself" : r.earshotSkipped;
    return `Not mirrored to the phone: the car that sent it ${why}.`;
  }
  if (!r.earshotKey || !r.earshotReason) return null;
  const why: Record<string, string> = {
    no_car_claim: "no car claimed the reply within the grace window after it was up (switched off, or out of reach)",
    car_let_go: "the car held it, then stopped renewing its hold before playing it (switched off while it waited)",
    browser_sender: "it was sent from a browser, which is not in the car",
    claim_failed: "the upload proxy could not be asked who speaks it (fail-open, a reply from before 2026-10-21)",
    skip_off: "every reply is mirrored (MEMO_EARSHOT_SKIP_CAR=0)"
  };
  return `Mirrored to the phone: ${why[r.earshotReason] ?? r.earshotReason}.`;
}

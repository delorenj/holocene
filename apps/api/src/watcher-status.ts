import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** One gateway lane's consumer as the watcher last probed it (NATS monitor), for the /voice banner and queue depth. */
export type LaneStatus = {
  /** true = a puller is attached; false = nobody is pulling this lane's consumer; undefined = unknown. */
  pulling?: boolean;
  waiting?: number;
  /** Commands being executed on this lane right now. */
  inFlight?: number;
  /** Commands queued behind the in-flight ones. */
  queued?: number;
  /** The lane's reserved slots (consumer max_ack_pending). */
  slots?: number;
  error?: string;
};

export type WatcherStatus = {
  state: "running" | "stopped" | "unknown";
  /** ISO time of the watcher's last heartbeat (it writes one every second while alive). */
  heartbeatAt?: string;
  ageSeconds?: number;
  active?: number;
  outbox?: number;
  /** Lane the watcher is configured to send memos on. */
  lane?: "interactive" | "batch";
  lanes?: { interactive?: LaneStatus; batch?: LaneStatus };
  detail: string;
};

const lanePart = (raw: unknown): LaneStatus | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const l = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    pulling: typeof l.ok === "boolean" ? l.ok : undefined,
    waiting: n(l.waiting), inFlight: n(l.ack_pending), queued: n(l.pending), slots: n(l.max_ack_pending),
    error: typeof l.error === "string" ? l.error : undefined
  };
};

const DIR = process.env.MEMO_STATE_DIR ?? join(homedir(), ".local/state/holocene-auto/inbox-watcher");

/**
 * Is holocene-inbox-watcher.service alive? Read from the heartbeat file it rewrites every tick plus a pid
 * probe. Holocene stays a sink: this only reads a local file, it publishes nothing.
 */
export async function readWatcherStatus(now = Date.now()): Promise<WatcherStatus> {
  let hb: { pid?: number; ts?: string; active?: unknown[]; outbox?: number; lane?: string; lanes?: Record<string, unknown> };
  try {
    hb = JSON.parse(await readFile(join(DIR, "heartbeat.json"), "utf8"));
  } catch {
    return { state: "unknown", detail: "no heartbeat file: the inbox watcher has never run on this host" };
  }
  const at = hb.ts ? Date.parse(hb.ts) : NaN;
  const age = Number.isFinite(at) ? Math.max(0, (now - at) / 1000) : undefined;
  let alive = true;
  if (typeof hb.pid === "number") {
    try { process.kill(hb.pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code === "EPERM"; }
  }
  const stopped = !alive || age === undefined || age > 60;
  return {
    state: stopped ? "stopped" : "running",
    heartbeatAt: hb.ts,
    ageSeconds: age,
    active: Array.isArray(hb.active) ? hb.active.length : undefined,
    outbox: typeof hb.outbox === "number" ? hb.outbox : undefined,
    lane: hb.lane === "interactive" || hb.lane === "batch" ? hb.lane : undefined,
    lanes: hb.lanes ? { interactive: lanePart(hb.lanes.interactive), batch: lanePart(hb.lanes.batch) } : undefined,
    detail: stopped
      ? `the inbox watcher is not running (${!alive ? "its process is gone" : `last heartbeat ${Math.round(age ?? 0)} s ago`}): memos wait in S3 until it is back`
      : "the inbox watcher is running"
  };
}

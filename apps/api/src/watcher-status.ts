import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type WatcherStatus = {
  state: "running" | "stopped" | "unknown";
  /** ISO time of the watcher's last heartbeat (it writes one every second while alive). */
  heartbeatAt?: string;
  ageSeconds?: number;
  active?: number;
  outbox?: number;
  detail: string;
};

const DIR = process.env.MEMO_STATE_DIR ?? join(homedir(), ".local/state/holocene-auto/inbox-watcher");

/**
 * Is holocene-inbox-watcher.service alive? Read from the heartbeat file it rewrites every tick plus a pid
 * probe. Holocene stays a sink: this only reads a local file, it publishes nothing.
 */
export async function readWatcherStatus(now = Date.now()): Promise<WatcherStatus> {
  let hb: { pid?: number; ts?: string; active?: unknown[]; outbox?: number };
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
    detail: stopped
      ? `the inbox watcher is not running (${!alive ? "its process is gone" : `last heartbeat ${Math.round(age ?? 0)} s ago`}): memos wait in S3 until it is back`
      : "the inbox watcher is running"
  };
}

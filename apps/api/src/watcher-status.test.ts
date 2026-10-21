import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "watcher-status-"));
process.env.MEMO_STATE_DIR = dir;
const { readWatcherStatus } = await import("./watcher-status.js");

const DRAINING = "gateway restarting (draining), memo queued; it runs when the gateway is back";

test("a draining gateway reaches /voice as draining, not as nobody pulling", async () => {
  const now = Date.parse("2026-10-20T23:00:00Z");
  const lane = (consumer: string, extra: Record<string, unknown>) => ({
    consumer, ok: false, waiting: 0, ack_pending: 0, pending: 2, max_ack_pending: 2, error: null,
    checked_at: "2026-10-20T22:59:59Z", ...extra
  });
  writeFileSync(join(dir, "heartbeat.json"), JSON.stringify({
    pid: process.pid, ts: "2026-10-20T22:59:59Z", active: [], outbox: 0, lane: "interactive",
    lanes: {
      interactive: lane("bloodbank-hermes-gateway-interactive", { draining: true, gateway: DRAINING }),
      batch: lane("bloodbank-hermes-gateway", { draining: false, gateway: null })
    }
  }));
  const status = await readWatcherStatus(now);
  assert.equal(status.state, "running");
  assert.equal(status.lanes?.interactive?.draining, true);
  assert.equal(status.lanes?.interactive?.gateway, DRAINING);
  assert.equal(status.lanes?.interactive?.pulling, false);
  assert.equal(status.lanes?.interactive?.queued, 2);
  // false and absent both read as "not draining"
  assert.equal(status.lanes?.batch?.draining, undefined);
  assert.equal(status.lanes?.batch?.gateway, undefined);
});

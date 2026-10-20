import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSnapshot, healthOf, parseLog } from "./containers.js";

const TARGETS = [
  "https://ok.delo.sh/ ok@docker ok",
  "https://locked.delo.sh/ locked@docker locked",
  "https://dead.delo.sh/ dead@docker dead",
  "https://gone.delo.sh/ gone@docker gone",
  "https://new.delo.sh/ new@docker new"
].join("\n");

// Two cron runs, 10 minutes apart; the newer one kicks `dead` and cannot map `gone`.
const LOG = [
  "2026-10-20T03:10:01Z probe https://ok.delo.sh/ -> 200",
  "2026-10-20T03:10:02Z probe https://dead.delo.sh/ -> 200",
  "2026-10-20T03:10:03Z could not map stale@docker to a container; skipping",
  "2026-10-20T03:20:01Z shell: curl -s -o /dev/null https://ok.delo.sh/",
  "2026-10-20T03:20:01Z probe https://ok.delo.sh/ -> 200",
  "2026-10-20T03:20:02Z probe https://locked.delo.sh/ -> 404",
  "2026-10-20T03:20:03Z probe https://dead.delo.sh/ -> 502",
  "2026-10-20T03:20:20Z probe https://gone.delo.sh/ -> 0",
  "2026-10-20T03:20:21Z could not map gone@docker to a container; skipping",
  "2026-10-20T03:20:22Z restarted dead",
  "2026-10-20T03:20:23Z published bloodbank event e1 for dead"
].join("\n");

const NOW = Date.parse("2026-10-20T03:25:00Z");
const restartedAt = Math.floor(Date.parse("2026-10-20T03:20:22Z") / 1000);

test("probe codes map to the deathwatch's own notion of dead", () => {
  assert.equal(healthOf(200, true), "healthy");
  assert.equal(healthOf(302, true), "healthy");
  assert.equal(healthOf(404, true), "answering");
  assert.equal(healthOf(401, true), "answering");
  assert.equal(healthOf(502, true), "dead");
  assert.equal(healthOf(0, true), "dead", "curl's 000 is no answer at all");
  assert.equal(healthOf(null, false), "unknown");
});

test("the last run starts at its earliest probe and only its skips count", () => {
  const log = parseLog(LOG);
  assert.equal(log.lastRunAt, "2026-10-20T03:20:01Z");
  assert.deepEqual(log.skipped, [{ container: "gone", reason: "no container behind the router" }]);
  assert.deepEqual(log.probes.get("https://dead.delo.sh/"), { status: 502, timestamp: "2026-10-20T03:20:03Z" });
  assert.deepEqual(log.probes.get("https://gone.delo.sh/"), { status: 0, timestamp: "2026-10-20T03:20:20Z" });
  assert.deepEqual(log.restarts, [{ at: "2026-10-20T03:20:22Z", container: "dead", outcome: "restarted", detail: "restarted dead" }]);
});

test("cooldown.json holds the restart time; the cooldown runs 30 minutes from it", () => {
  const snap = buildSnapshot({ targetsText: TARGETS, logText: LOG, cooldownText: JSON.stringify({ dead: restartedAt, ok: restartedAt - 7200 }), nowMs: NOW });
  const dead = snap.targets.find((t) => t.container === "dead")!;
  assert.equal(dead.inCooldown, true);
  assert.equal(dead.lastRestartAt, "2026-10-20T03:20:22.000Z");
  assert.equal(dead.cooldownUntil, "2026-10-20T03:50:22.000Z");
  const ok = snap.targets.find((t) => t.container === "ok")!;
  assert.equal(ok.inCooldown, false, "a restart two hours ago is long out of cooldown");
  assert.equal(ok.lastRestartAt, "2026-10-20T01:20:22.000Z");
});

test("the snapshot summarises health and POLR is pissed after a kick this hour", () => {
  const snap = buildSnapshot({ targetsText: TARGETS, logText: LOG, cooldownText: "{}", nowMs: NOW });
  assert.deepEqual(snap.summary, { total: 5, healthy: 1, answering: 1, dead: 2, unknown: 1, inCooldown: 0, restartsLastHour: 1 });
  assert.equal(snap.stale, false);
  assert.equal(snap.nextRunAt, "2026-10-20T03:30:01.000Z");
  assert.equal(snap.polr.mood, "pissed");
});

test("POLR is grumpy at dead routes it cannot fix, calm when all answer, asleep when the cron stops", () => {
  const later = NOW + 2 * 3600_000;
  const grumpy = buildSnapshot({ targetsText: TARGETS, logText: LOG.replace(/03:20/g, "05:20"), cooldownText: "{}", nowMs: later });
  assert.equal(grumpy.polr.mood, "pissed", "the rewritten restart is inside the hour again");
  const noKick = LOG.split("\n").filter((l) => !l.includes("restarted")).join("\n").replace(/03:20/g, "05:20");
  assert.equal(buildSnapshot({ targetsText: TARGETS, logText: noKick, cooldownText: "{}", nowMs: later }).polr.mood, "grumpy");
  const calm = "2026-10-20T05:20:01Z probe https://ok.delo.sh/ -> 200\n2026-10-20T05:20:02Z all targets healthy";
  assert.equal(buildSnapshot({ targetsText: TARGETS.split("\n")[0], logText: calm, cooldownText: "{}", nowMs: later }).polr.mood, "calm");
  assert.equal(buildSnapshot({ targetsText: TARGETS, logText: LOG, cooldownText: "{}", nowMs: later }).polr.mood, "asleep");
});

test("an unreadable cooldown file and an empty log are no state, not a crash", () => {
  const snap = buildSnapshot({ targetsText: TARGETS, logText: "", cooldownText: "not json", nowMs: NOW });
  assert.equal(snap.lastRunAt, null);
  assert.equal(snap.stale, true);
  assert.equal(snap.summary.unknown, 5);
  assert.equal(snap.polr.mood, "asleep");
});

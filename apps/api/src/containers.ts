import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Traefik Deathwatch (~/code/infra/scripts/traefik-deathwatch.py, cron every 10 min) probes every public
// Traefik router, restarts the container behind one that answers a failure code, and remembers the restart
// time per container in cooldown.json. This module reads its state files; it never runs or steers it.
const HOME = homedir();
const STATE_DIR = process.env.TRAEFIK_DEATHWATCH_STATE_DIR ?? join(HOME, ".local", "state", "traefik-deathwatch");
const TARGETS_FILE = join(STATE_DIR, "targets.txt");
const LOG_FILE = join(STATE_DIR, "deathwatch.log");
const OLD_LOG_FILE = join(STATE_DIR, "deathwatch.log.1");
const COOLDOWN_FILE = join(STATE_DIR, "cooldown.json");

// The same knobs, and defaults, the deathwatch reads.
const FAILURE_CODES = new Set(
  (process.env.TRAEFIK_DEATHWATCH_FAILURE_CODES ?? "502,503,504")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x))
);
const COOLDOWN_SECONDS = Number(process.env.TRAEFIK_DEATHWATCH_COOLDOWN ?? "1800");
const RUN_INTERVAL_SECONDS = 600;
const RECENT_RESTARTS = 20;
const PISSED_WINDOW_SECONDS = 3600;

// healthy: 2xx/3xx. answering: up but refusing this probe (401/403/404 ...), never a restart trigger.
// dead: a failure code or no HTTP answer at all (curl's 000). unknown: never probed.
export type TargetHealth = "healthy" | "answering" | "dead" | "unknown";
export type PolrMood = "calm" | "grumpy" | "pissed" | "asleep";

export type ContainerTarget = {
  url: string;
  service: string;
  container: string;
  health: TargetHealth;
  lastStatus: number | null;
  lastProbeAt: string | null;
  lastRestartAt: string | null;
  inCooldown: boolean;
  cooldownUntil: string | null;
};

export type RestartEvent = {
  at: string;
  container: string;
  outcome: "restarted" | "failed" | "queued";
  detail: string;
};

export type ContainersSnapshot = {
  generatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  stale: boolean;
  polr: { mood: PolrMood; line: string };
  targets: ContainerTarget[];
  restarts: RestartEvent[];
  skipped: { container: string; reason: string }[];
  summary: {
    total: number;
    healthy: number;
    answering: number;
    dead: number;
    unknown: number;
    inCooldown: number;
    restartsLastHour: number;
  };
};

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+(.*)$/;

export function parseTargets(text: string): { url: string; service: string; container: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        url: parts[0] ?? "",
        service: parts[1] ?? "",
        container: parts[2] ?? parts[1]?.split("@")[0] ?? ""
      };
    });
}

export type ParsedLog = {
  probes: Map<string, { status: number | null; timestamp: string }>;
  lastRunAt: string | null;
  restarts: RestartEvent[];
  skipped: { container: string; reason: string }[];
};

// One pass, newest line first. A run is the block of probe lines one cron tick writes; the newest probe's run
// is the last run, and its skip lines say what the deathwatch saw dead but would not touch.
export function parseLog(text: string): ParsedLog {
  const probes = new Map<string, { status: number | null; timestamp: string }>();
  const restarts: RestartEvent[] = [];
  const skipped: { container: string; reason: string }[] = [];
  let lastRunAt: string | null = null;
  let newestProbeAt: string | null = null;
  const lines = text.split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].trim().match(LINE_RE);
    if (!match) continue;
    const [, at, message] = match;

    const probe = message.match(/^probe\s+(\S+)\s+->\s+(\S+)/);
    if (probe) {
      const [, url, code] = probe;
      if (!probes.has(url)) probes.set(url, { status: /^\d+$/.test(code) ? Number(code) : null, timestamp: at });
      // the run started at its earliest probe; one run's probes sit within a few minutes, runs 10 apart
      newestProbeAt ??= at;
      if (Date.parse(newestProbeAt) - Date.parse(at) < 300_000) lastRunAt = at;
      continue;
    }

    // read newest first, the lines before the first probe met are the last run's verdicts
    const inLastRun = probes.size === 0;
    let m: RegExpMatchArray | null;
    if ((m = message.match(/^restarted (\S+)$/))) {
      if (restarts.length < RECENT_RESTARTS) restarts.push({ at, container: m[1], outcome: "restarted", detail: message });
    } else if ((m = message.match(/^failed to restart (\S+?):\s*(.*)$/))) {
      if (restarts.length < RECENT_RESTARTS) restarts.push({ at, container: m[1], outcome: "failed", detail: m[2] || message });
    } else if ((m = message.match(/^(\S+) container is missing; queued a restart of (\S+)/))) {
      if (restarts.length < RECENT_RESTARTS) restarts.push({ at, container: m[1], outcome: "queued", detail: message });
    } else if (inLastRun && (m = message.match(/^could not map (\S+) to a container; skipping$/))) {
      skipped.push({ container: m[1].split("@")[0], reason: "no container behind the router" });
    } else if (inLastRun && (m = message.match(/^(\S+) on cooldown; skipped$/))) {
      skipped.push({ container: m[1], reason: "on cooldown" });
    } else if (inLastRun && (m = message.match(/^no service detail for (\S+); skipping$/))) {
      skipped.push({ container: m[1].split("@")[0], reason: "Traefik has no service detail" });
    }
  }

  return { probes, lastRunAt, restarts, skipped };
}

export function parseCooldown(text: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) if (typeof value === "number") map.set(key, value);
    }
  } catch {
    // unreadable: no cooldowns
  }
  return map;
}

export function healthOf(status: number | null, probed: boolean): TargetHealth {
  if (!probed) return "unknown";
  if (status === null || status === 0 || FAILURE_CODES.has(status)) return "dead";
  if (status >= 200 && status < 400) return "healthy";
  return "answering";
}

export function polrMood(input: { stale: boolean; dead: number; restartsLastHour: number; failedLastHour: number }): {
  mood: PolrMood;
  line: string;
} {
  if (input.stale) return { mood: "asleep", line: "Deathwatch hasn't run in a while. Nobody is watching." };
  if (input.failedLastHour > 0) return { mood: "pissed", line: `Tried to kick ${input.failedLastHour} and it didn't take.` };
  if (input.restartsLastHour > 0)
    return { mood: "pissed", line: `Had to kick ${input.restartsLastHour} container${input.restartsLastHour === 1 ? "" : "s"} this hour.` };
  if (input.dead > 0) return { mood: "grumpy", line: `${input.dead} dead route${input.dead === 1 ? "" : "s"} I can't fix by restarting.` };
  return { mood: "calm", line: "Every route answers. Nothing to kick." };
}

export function buildSnapshot(input: {
  targetsText: string;
  logText: string;
  cooldownText: string;
  nowMs: number;
}): ContainersSnapshot {
  const targets = parseTargets(input.targetsText);
  const log = parseLog(input.logText);
  const cooldowns = parseCooldown(input.cooldownText);
  const nowS = Math.floor(input.nowMs / 1000);

  const containerTargets: ContainerTarget[] = targets.map((t) => {
    const probe = log.probes.get(t.url);
    const restartedAt = cooldowns.get(t.container);
    const until = restartedAt !== undefined ? restartedAt + COOLDOWN_SECONDS : undefined;
    const inCooldown = until !== undefined && until > nowS;
    return {
      url: t.url,
      service: t.service,
      container: t.container,
      health: healthOf(probe?.status ?? null, probe !== undefined),
      lastStatus: probe?.status ?? null,
      lastProbeAt: probe?.timestamp ?? null,
      lastRestartAt: restartedAt !== undefined ? new Date(restartedAt * 1000).toISOString() : null,
      inCooldown,
      cooldownUntil: inCooldown ? new Date(until! * 1000).toISOString() : null
    };
  });

  const count = (h: TargetHealth) => containerTargets.filter((t) => t.health === h).length;
  const recent = log.restarts.filter((r) => input.nowMs - Date.parse(r.at) < PISSED_WINDOW_SECONDS * 1000);
  const restartsLastHour = recent.filter((r) => r.outcome !== "failed").length;
  const failedLastHour = recent.filter((r) => r.outcome === "failed").length;
  const lastRunMs = log.lastRunAt ? Date.parse(log.lastRunAt) : null;
  const stale = lastRunMs === null || input.nowMs - lastRunMs > 2 * RUN_INTERVAL_SECONDS * 1000 + 60_000;
  const dead = count("dead");
  const skipped = [...new Map(log.skipped.map((s) => [s.container, s])).values()].reverse();

  return {
    generatedAt: new Date(input.nowMs).toISOString(),
    lastRunAt: log.lastRunAt,
    nextRunAt: lastRunMs === null ? null : new Date(lastRunMs + RUN_INTERVAL_SECONDS * 1000).toISOString(),
    stale,
    polr: polrMood({ stale, dead, restartsLastHour, failedLastHour }),
    targets: containerTargets,
    restarts: log.restarts,
    skipped,
    summary: {
      total: containerTargets.length,
      healthy: count("healthy"),
      answering: count("answering"),
      dead,
      unknown: count("unknown"),
      inCooldown: containerTargets.filter((t) => t.inCooldown).length,
      restartsLastHour
    }
  };
}

// The log is up to 5 MB plus its rotated predecessor; read them again only when they change.
let logCache: { key: string; text: string } | null = null;

function readText(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function readLogs(): string {
  const stamp = (path: string) => {
    try {
      const s = statSync(path);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "-";
    }
  };
  const key = `${stamp(OLD_LOG_FILE)}|${stamp(LOG_FILE)}`;
  if (logCache?.key !== key) logCache = { key, text: `${readText(OLD_LOG_FILE)}\n${readText(LOG_FILE)}` };
  return logCache.text;
}

export async function getContainersSnapshot(): Promise<ContainersSnapshot> {
  return buildSnapshot({
    targetsText: readText(TARGETS_FILE),
    logText: readLogs(),
    cooldownText: readText(COOLDOWN_FILE),
    nowMs: Date.now()
  });
}

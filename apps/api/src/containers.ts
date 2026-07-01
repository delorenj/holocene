import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const STATE_DIR = join(HOME, ".local", "state", "traefik-deathwatch");
const TARGETS_FILE = join(STATE_DIR, "targets.txt");
const LOG_FILE = join(STATE_DIR, "deathwatch.log");
const COOLDOWN_FILE = join(STATE_DIR, "cooldown.json");

export type ContainerTarget = {
  url: string;
  service: string;
  container: string;
  lastStatus: number | null;
  lastProbeAt: string | null;
  inCooldown: boolean;
  cooldownUntil: string | null;
};

export type ContainersSnapshot = {
  generatedAt: string;
  targets: ContainerTarget[];
  summary: {
    total: number;
    healthy: number;
    unhealthy: number;
    unknown: number;
    inCooldown: number;
  };
};

function readTargets(): { url: string; service: string; container: string }[] {
  if (!existsSync(TARGETS_FILE)) return [];
  try {
    const text = readFileSync(TARGETS_FILE, "utf8");
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
  } catch {
    return [];
  }
}

function readProbes(): Map<string, { status: number; timestamp: string }> {
  const probes = new Map<string, { status: number; timestamp: string }>();
  if (!existsSync(LOG_FILE)) return probes;

  try {
    const text = readFileSync(LOG_FILE, "utf8");
    const lines = text.split("\n");

    // scan in reverse to find most recent probe per URL
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      const probeMatch = line.match(
        /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+probe\s+(\S+)\s+->\s+(\d{3})/
      );
      if (probeMatch) {
        const [, timestamp, url, code] = probeMatch;
        if (!probes.has(url)) {
          probes.set(url, { status: Number(code), timestamp });
        }
      }
    }
  } catch {
    // file unreadable — empty map
  }

  return probes;
}

function readCooldowns(): Map<string, number> {
  if (!existsSync(COOLDOWN_FILE)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(COOLDOWN_FILE, "utf8"));
    const map = new Map<string, number>();
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "number") map.set(key, value);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export async function getContainersSnapshot(): Promise<ContainersSnapshot> {
  const targets = readTargets();
  const probes = readProbes();
  const cooldowns = readCooldowns();
  const now = Math.floor(Date.now() / 1000);

  const containerTargets: ContainerTarget[] = targets.map((t) => {
    const probe = probes.get(t.url);
    const cooldownUntil = cooldowns.get(t.container);

    let inCooldown = false;
    let cooldownIso: string | null = null;

    if (cooldownUntil !== undefined) {
      if (cooldownUntil > now) {
        inCooldown = true;
        cooldownIso = new Date(cooldownUntil * 1000).toISOString();
      }
    }

    return {
      url: t.url,
      service: t.service,
      container: t.container,
      lastStatus: probe?.status ?? null,
      lastProbeAt: probe?.timestamp ?? null,
      inCooldown,
      cooldownUntil: cooldownIso
    };
  });

  let healthy = 0;
  let unhealthy = 0;
  let unknown = 0;
  let inCooldown = 0;

  for (const t of containerTargets) {
    if (t.inCooldown) inCooldown++;
    if (t.lastStatus === null) {
      unknown++;
    } else if (t.lastStatus >= 200 && t.lastStatus < 400) {
      healthy++;
    } else {
      unhealthy++;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    targets: containerTargets,
    summary: {
      total: containerTargets.length,
      healthy,
      unhealthy,
      unknown,
      inCooldown
    }
  };
}

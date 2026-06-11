import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BGLS_BIN = process.env.BGLS_BIN ?? "/home/delorenj/code/infra/bin/bgls";
const PROMETHEUS_URL = (process.env.PROMETHEUS_URL ?? "http://127.0.0.1:9472").replace(/\/$/, "");
const INVENTORY_CACHE_MS = 10_000;

const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
const userRuntimeDir = process.env.XDG_RUNTIME_DIR ?? (uid === undefined ? undefined : `/run/user/${uid}`);
const systemdEnv = {
  ...process.env,
  ...(userRuntimeDir ? { XDG_RUNTIME_DIR: userRuntimeDir } : {}),
  ...(process.env.DBUS_SESSION_BUS_ADDRESS
    ? {}
    : userRuntimeDir
      ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${userRuntimeDir}/bus` }
      : {})
};

export type SystemsItem = {
  type: string;
  name: string;
  state: string;
  schedule: string;
  source: string;
  detail: string;
};

export type SystemsInventory = {
  generatedAt: string;
  items: SystemsItem[];
  counts: {
    total: number;
    failed: number;
    unhealthy: number;
    byType: Record<string, number>;
  };
};

let inventoryCache: { at: number; value: SystemsInventory } | null = null;

export async function getSystemsInventory(force = false): Promise<SystemsInventory> {
  if (!force && inventoryCache && Date.now() - inventoryCache.at < INVENTORY_CACHE_MS) {
    return inventoryCache.value;
  }
  const { stdout } = await execFileAsync(BGLS_BIN, ["--json"], {
    env: systemdEnv,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024
  });
  const items = JSON.parse(stdout) as SystemsItem[];
  const byType: Record<string, number> = {};
  for (const item of items) byType[item.type] = (byType[item.type] ?? 0) + 1;
  const value: SystemsInventory = {
    generatedAt: new Date().toISOString(),
    items,
    counts: {
      total: items.length,
      failed: items.filter((i) => i.state.includes("failed")).length,
      unhealthy: items.filter((i) => i.state.includes("unhealthy") || i.state.includes("restarting")).length,
      byType
    }
  };
  inventoryCache = { at: Date.now(), value };
  return value;
}

type PromMatrix = {
  status: string;
  data?: { result?: { metric: Record<string, string>; values: [number, string][] }[] };
};

async function queryRange(query: string, start: number, end: number, stepSeconds: number) {
  const url =
    `${PROMETHEUS_URL}/api/v1/query_range?query=${encodeURIComponent(query)}` +
    `&start=${start}&end=${end}&step=${stepSeconds}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`prometheus ${res.status}`);
  const body = (await res.json()) as PromMatrix;
  if (body.status !== "success") throw new Error("prometheus query failed");
  return (body.data?.result ?? []).map((series) => ({
    labels: series.metric,
    points: series.values.map(([ts, v]) => ({ t: ts, v: Number(v) }))
  }));
}

const HISTORY_SERIES: { id: string; label: string; query: string }[] = [
  { id: "load1", label: "Load (1m)", query: 'bgls_loadavg{window="1m"}' },
  {
    id: "containers_running",
    label: "Containers running",
    query: 'sum(bgls_items{type="docker",state="running"})'
  },
  {
    id: "problems",
    label: "Problem units",
    query: "sum(bgls_unit_problem) or vector(0)"
  },
  {
    id: "usr_failed",
    label: "Failed user services",
    query: 'sum(bgls_items{type="usr-svc",state="failed"}) or vector(0)'
  }
];

export async function getSystemsHistory(rangeHours: number) {
  const clamped = Math.max(1, Math.min(rangeHours, 24 * 14));
  const end = Math.floor(Date.now() / 1000);
  const start = end - clamped * 3600;
  const step = Math.max(60, Math.floor((clamped * 3600) / 300));
  const series = await Promise.all(
    HISTORY_SERIES.map(async (s) => {
      try {
        const result = await queryRange(s.query, start, end, step);
        return { id: s.id, label: s.label, points: result[0]?.points ?? [] };
      } catch {
        return { id: s.id, label: s.label, points: [] };
      }
    })
  );
  return { generatedAt: new Date().toISOString(), rangeHours: clamped, stepSeconds: step, series };
}

const ACTIONABLE_TYPES = new Set(["usr-svc", "usr-timer", "docker", "pm2"]);
const ACTIONS = new Set(["stop", "restart", "start", "disable"]);
const SAFE_NAME = /^[A-Za-z0-9@._:-]+$/;

export async function systemsItemAction(type: string, name: string, action: string) {
  if (!ACTIONABLE_TYPES.has(type)) throw new Error(`type ${type} is not actionable from the dashboard`);
  if (!ACTIONS.has(action)) throw new Error(`unsupported action ${action}`);
  if (!SAFE_NAME.test(name)) throw new Error("invalid unit name");
  await execFileAsync(BGLS_BIN, [action, type, name], { env: systemdEnv, timeout: 60_000 });
  inventoryCache = null;
  return { ok: true, type, name, action };
}

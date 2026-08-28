import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { load } from "js-yaml";

const execFileAsync = promisify(execFile);

const SRVLS_BIN = process.env.SRVLS_BIN ?? "/home/delorenj/code/infra/bin/srvls";
const PROMETHEUS_URL = (process.env.PROMETHEUS_URL ?? "http://127.0.0.1:9472").replace(/\/$/, "");
const HERMES_REGISTRY_PATH = process.env.HERMES_REGISTRY_PATH ?? "/home/delorenj/.hermes/agents-registry.yaml";
const PLANE_BASE_URL = (process.env.PLANE_BASE_URL ?? "https://plane.delo.sh").replace(/\/$/, "");
const INVENTORY_CACHE_MS = 10_000;
const PREVIEW_MAX_BYTES = 160 * 1024;

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
  purpose: string;
  context: string;
  scheduleSemantic: string;
  state: string;
  schedule: string;
  source: string;
  detail: string;
  preview?: SystemsPreviewTarget;
  project?: SystemsProjectLink;
  pm?: SystemsPmLink;
  board?: SystemsBoardLink;
};

type RawSystemsItem = Pick<SystemsItem, "type" | "name" | "state" | "schedule" | "source" | "detail">;

export type SystemsPreviewTarget = {
  kind: "file" | "unit";
  target: string;
  label: string;
};

export type SystemsProjectLink = {
  repo: string;
  path: string;
};

export type SystemsPmLink = {
  agentId: string;
  displayName: string;
  roleDir: string;
  hermesPath: string;
};

export type SystemsBoardLink = {
  provider: "plane" | "linear" | "trello";
  label: string;
  url: string;
};

type RegistryAgent = {
  agentId: string;
  repo: string;
  role: string;
  displayName: string;
  projectPath: string;
  roleDir: string;
  profileName: string;
  plane?: {
    workspace?: string;
    project_id?: string;
    identifier?: string;
  };
  ticketProvider?: {
    name?: string;
    board_url?: string;
    board_id?: string;
    workspace?: string;
    project?: string;
  };
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
  const { stdout } = await execFileAsync(SRVLS_BIN, ["--json"], {
    env: systemdEnv,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024
  });
  const registry = readProjectRegistry();
  const items = (JSON.parse(stdout) as RawSystemsItem[]).map((item) => enrichSystemsItem(item, registry));
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

function enrichSystemsItem(item: RawSystemsItem, registry: RegistryAgent[]): SystemsItem {
  const context = deriveContext(item);
  const projectAgent = matchProjectAgent(item, registry);
  const preview = derivePreview(item);
  return {
    ...item,
    purpose: derivePurpose(item, context),
    context,
    scheduleSemantic: semanticCron(item.schedule),
    preview,
    ...(projectAgent ? { project: { repo: projectAgent.repo, path: projectAgent.projectPath } } : {}),
    ...(projectAgent ? { pm: pmLink(projectAgent) } : {}),
    ...(projectAgent ? boardLink(projectAgent) : {})
  };
}

function readProjectRegistry(): RegistryAgent[] {
  if (!existsSync(HERMES_REGISTRY_PATH)) return [];
  try {
    const parsed = load(readFileSync(HERMES_REGISTRY_PATH, "utf8")) as any;
    const agents = parsed?.agents && typeof parsed.agents === "object" ? parsed.agents : {};
    return Object.entries<any>(agents)
      .map(([agentId, cfg]) => ({
        agentId,
        repo: stringValue(cfg.repo),
        role: stringValue(cfg.role),
        displayName: stringValue(cfg.display_name) || agentId,
        projectPath: stringValue(cfg.project_path),
        roleDir: stringValue(cfg.role_dir),
        profileName: stringValue(cfg.profile_name),
        plane: cfg.plane,
        ticketProvider: cfg.ticket_provider
      }))
      .filter((agent) => agent.role === "pm" && agent.projectPath && agent.roleDir)
      .sort((a, b) => b.projectPath.length - a.projectPath.length);
  } catch {
    return [];
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function pmLink(agent: RegistryAgent): SystemsPmLink {
  return {
    agentId: agent.agentId,
    displayName: agent.displayName,
    roleDir: agent.roleDir,
    hermesPath: `${agent.roleDir}/hermes`
  };
}

function boardLink(agent: RegistryAgent): { board: SystemsBoardLink } | {} {
  const provider = agent.ticketProvider?.name;
  const url = agent.ticketProvider?.board_url;
  if ((provider === "plane" || provider === "linear" || provider === "trello") && url) {
    return { board: { provider, label: `${agent.displayName} board`, url } };
  }

  const workspace = agent.plane?.workspace;
  const projectId = agent.plane?.project_id;
  if (workspace && projectId) {
    return {
      board: {
        provider: "plane",
        label: agent.plane?.identifier ? `${agent.plane.identifier} board` : `${agent.displayName} board`,
        url: `${PLANE_BASE_URL}/${workspace}/projects/${projectId}/issues/`
      }
    };
  }

  return {};
}

function matchProjectAgent(item: RawSystemsItem, registry: RegistryAgent[]) {
  const hermesAgentId = hermesAgentIdFromName(item.name);
  if (hermesAgentId) {
    const exact = registry.find((agent) => agent.agentId === hermesAgentId);
    if (exact) return exact;
  }

  const paths = itemPaths(item);
  return registry.find((agent) => paths.some((path) => pathIsInside(path, agent.projectPath)));
}

function hermesAgentIdFromName(name: string) {
  if (!name.startsWith("hermes-")) return "";
  return name
    .replace(/^hermes-/, "")
    .replace(/-(gateway|consumer|checkpoint|continuous-ticket-sentinel)\.(service|timer)$/i, "");
}

function itemPaths(item: RawSystemsItem) {
  return [...new Set([...allPaths(item.source), ...allPaths(item.detail)].map(expandHomePath))];
}

function pathIsInside(path: string, parent: string) {
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;
  return path === parent || path.startsWith(normalizedParent);
}

function derivePurpose(item: RawSystemsItem, context: string) {
  if (item.type === "cron") return deriveCronPurpose(item, context);
  if (item.type === "docker") return [context, prettyName(item.name)].filter(Boolean).join(": ");
  if (item.type === "pm2") return [context, prettyName(item.name)].filter(Boolean).join(": ");
  if (item.type.endsWith("timer")) {
    const target = item.source && item.source !== item.name ? item.source : item.name;
    return `${prettyName(target)} timer`;
  }
  if (isUsefulDetail(item.detail)) return item.detail.trim();
  return [context, prettyName(item.name)].filter(Boolean).join(": ") || item.name;
}

function deriveCronPurpose(item: RawSystemsItem, context: string) {
  const comment = item.detail.match(/(?:^|\s)#\s*(.+)$/)?.[1]?.trim();
  if (comment) return comment;

  const checkpointTarget = item.detail.match(/\bgit-checkpoint\s+(\S+)/)?.[1];
  if (checkpointTarget) return `Git checkpoint: ${formatPath(checkpointTarget)}`;

  const runParts = item.detail.match(/run-parts\s+--report\s+\/etc\/cron\.(\w+)/);
  if (runParts) return `System cron: ${runParts[1]} jobs`;

  const path = meaningfulCronPath(item.detail);
  if (path) {
    const base = basename(path);
    return [context, prettyName(base)].filter(Boolean).join(": ");
  }

  const cronFile = item.source.match(/^\/etc\/cron\.d\/([^/]+)$/)?.[1];
  if (cronFile) return prettyName(cronFile);

  return [context, prettyName(item.name)].filter(Boolean).join(": ") || item.detail;
}

function deriveContext(item: RawSystemsItem) {
  const sourceContext = pathContext(item.source);
  if (sourceContext) return sourceContext;

  const detailContext = pathContext(item.detail);
  if (detailContext) return detailContext;

  if (item.type.endsWith("timer") && item.source) return prettyName(item.source);
  return "";
}

function isUsefulDetail(detail: string) {
  const clean = detail.trim();
  return clean.length > 0 && !clean.startsWith("restart=");
}

function pathContext(value: string) {
  const path = firstPath(value);
  if (!path) return "";
  if (path.startsWith("/home/delorenj/code/")) {
    const parts = path.replace("/home/delorenj/code/", "").split("/").filter(Boolean);
    if (parts[0] === "33GOD" && parts[1]) return `33GOD/${parts[1]}`;
    return parts[0] ?? "";
  }
  if (path.startsWith("/home/delorenj/docker/stacks/")) {
    const parts = path.replace("/home/delorenj/docker/stacks/", "").split("/").filter(Boolean);
    return parts.length >= 2 ? `docker/${parts[0]}/${parts[1]}` : "docker/stacks";
  }
  if (path.startsWith("/home/delorenj/.config/")) {
    return `~/.config/${path.replace("/home/delorenj/.config/", "").split("/")[0]}`;
  }
  if (path.startsWith("/home/delorenj/.local/bin/")) return "~/.local/bin";
  if (path.startsWith("/home/delorenj/.n8n")) return "~/.n8n";
  if (path.startsWith("/home/delorenj/")) {
    const parts = path.replace("/home/delorenj/", "").split("/").filter(Boolean);
    return parts[0] ? `~/${parts[0]}` : "~";
  }
  if (path.startsWith("/etc/")) return "/etc";
  return "";
}

function firstPath(value: string) {
  return value.match(/(?:~|\/)[^\s;&|)]+/)?.[0]?.replace(/[.,]$/, "") ?? "";
}

function allPaths(value: string) {
  return [...value.matchAll(/(?:~|\/)[^\s;&|)]+/g)].map((match) => match[0].replace(/[.,]$/, ""));
}

function meaningfulCronPath(value: string) {
  const paths = allPaths(value);
  return (
    paths.find(
      (path) =>
        !path.startsWith("/run/") &&
        !path.startsWith("/dev/") &&
        !path.startsWith("/etc/init.d/") &&
        !path.endsWith("/system") &&
        !path.endsWith("/anacron")
    ) ??
    ""
  );
}

function derivePreview(item: RawSystemsItem): SystemsPreviewTarget | undefined {
  if (item.type === "docker") {
    const compose = dockerComposePath(item.source);
    if (compose) return { kind: "file", target: compose, label: formatPath(compose) };
  }

  const sourcePath = expandHomePath(firstPath(item.source));
  if (sourcePath && existsSync(sourcePath)) return { kind: "file", target: sourcePath, label: formatPath(sourcePath) };

  const detailPath = expandHomePath(meaningfulCronPath(item.detail));
  if (detailPath && existsSync(detailPath)) return { kind: "file", target: detailPath, label: formatPath(detailPath) };

  if (item.type === "usr-svc" || item.type === "usr-timer" || item.type === "sys-svc" || item.type === "sys-timer") {
    return {
      kind: "unit",
      target: `${item.type.startsWith("usr-") ? "user" : "system"}:${item.name}`,
      label: item.name
    };
  }

  return undefined;
}

function dockerComposePath(source: string) {
  const path = expandHomePath(firstPath(source));
  if (!path || !existsSync(path)) return "";
  const candidates = ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"];
  return candidates.map((file) => `${path}/${file}`).find((file) => existsSync(file)) ?? "";
}

function semanticCron(schedule: string) {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule || "-";
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const at = timeText(hour, minute);
  const day = dayOfWeekText(dayOfWeek);
  const dom = ordinalText(dayOfMonth);
  const monthText = month === "*" ? "" : ` in ${monthName(month)}`;

  if (minute.startsWith("*/") && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${minute.slice(2)} minutes`;
  }
  if (minute === "0" && hour.startsWith("*/") && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${hour.slice(2)} hours`;
  }
  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Hourly at ${minuteText(minute)}`;
  }
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Every day at ${at}`;
  if (dayOfMonth === "*" && month === "*" && day) return `Every ${day} at ${at}`;
  if (dayOfMonth !== "*" && dayOfWeek === "*") return `Every ${dom}${monthText} at ${at}`;
  return `Cron: ${schedule}`;
}

function minuteText(minute: string) {
  return minute === "0" ? "the hour" : `:${minute.padStart(2, "0")}`;
}

function timeText(hour: string, minute: string) {
  if (!/^\d+$/.test(hour) || !/^\d+$/.test(minute)) return `${hour}:${minute}`;
  const h = Number(hour);
  const m = Number(minute);
  const suffix = h >= 12 ? "PM" : "AM";
  const displayHour = h % 12 || 12;
  return `${displayHour}:${String(m).padStart(2, "0")} ${suffix}`;
}

function dayOfWeekText(value: string) {
  if (value === "*") return "";
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const parts = value.split(",");
  return parts
    .map((part) => {
      const normalized = part === "7" ? "0" : part;
      return /^\d+$/.test(normalized) ? names[Number(normalized)] : prettyName(part);
    })
    .join(", ");
}

function ordinalText(value: string) {
  if (!/^\d+$/.test(value)) return value;
  const n = Number(value);
  const suffix = n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";
  return `${n}${suffix}`;
}

function monthName(value: string) {
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return /^\d+$/.test(value) ? (names[Number(value) - 1] ?? value) : prettyName(value);
}

function expandHomePath(path: string) {
  return path.startsWith("~/") ? `/home/delorenj/${path.slice(2)}` : path;
}

function formatPath(path: string) {
  if (path.startsWith("/home/delorenj/")) return `~/${path.slice("/home/delorenj/".length).replace(/\/$/, "")}`;
  return path.replace(/\/$/, "");
}

function basename(path: string) {
  return path.replace(/\/$/, "").split("/").pop() ?? path;
}

function prettyName(value: string) {
  return value
    .replace(/\.(service|timer|target|socket|path|sh|py|js|ts)$/i, "")
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

const ALLOWED_PREVIEW_ROOTS = [
  "/home/delorenj/code",
  "/home/delorenj/docker",
  "/home/delorenj/.config",
  "/home/delorenj/.local/bin",
  "/home/delorenj/.n8n",
  "/etc/crontab",
  "/etc/cron.d"
];

export type SystemsPreview = {
  kind: SystemsPreviewTarget["kind"];
  target: string;
  label: string;
  content: string;
  truncated: boolean;
  sizeBytes?: number;
  generatedAt: string;
};

function validatePreviewTarget(kind: string, target: string): SystemsPreviewTarget {
  if (kind !== "file" && kind !== "unit") throw new Error("invalid preview kind");
  if (!target.trim()) throw new Error("missing preview target");
  return { kind, target, label: target } as SystemsPreviewTarget;
}

function unitCommand(target: string) {
  const [scope, unit] = target.split(":", 2);
  if ((scope !== "user" && scope !== "system") || !SAFE_NAME.test(unit ?? "")) throw new Error("invalid unit target");
  return {
    command: "systemctl",
    args: scope === "user" ? ["--user", "cat", unit] : ["cat", unit]
  };
}

function validatedPreviewFile(target: string) {
  const real = realpathSync(expandHomePath(target));
  if (!ALLOWED_PREVIEW_ROOTS.some((root) => pathIsInside(real, root))) {
    throw new Error("preview target is outside allowed roots");
  }
  const stats = statSync(real);
  if (!stats.isFile()) throw new Error("preview target is not a file");
  return { real, stats };
}

export async function getSystemsPreview(kind: string, target: string): Promise<SystemsPreview> {
  const preview = validatePreviewTarget(kind, target);
  if (preview.kind === "unit") {
    const { command, args } = unitCommand(preview.target);
    const { stdout } = await execFileAsync(command, args, {
      env: systemdEnv,
      timeout: 10_000,
      maxBuffer: PREVIEW_MAX_BYTES
    });
    return {
      kind: preview.kind,
      target: preview.target,
      label: preview.target.split(":").slice(1).join(":") || preview.target,
      content: stdout,
      truncated: stdout.length >= PREVIEW_MAX_BYTES,
      generatedAt: new Date().toISOString()
    };
  }

  const { real, stats } = validatedPreviewFile(preview.target);
  const buffer = readFileSync(real);
  const truncated = buffer.length > PREVIEW_MAX_BYTES;
  return {
    kind: preview.kind,
    target: real,
    label: formatPath(real),
    content: buffer.subarray(0, PREVIEW_MAX_BYTES).toString("utf8"),
    truncated,
    sizeBytes: stats.size,
    generatedAt: new Date().toISOString()
  };
}

export async function openSystemsPreviewTerminal(kind: string, target: string) {
  const preview = validatePreviewTarget(kind, target);
  const alacritty = "/home/delorenj/.local/bin/alacritty";
  if (!existsSync(alacritty)) throw new Error("alacritty is not available");

  let command: string;
  if (preview.kind === "unit") {
    const { command: unitBin, args } = unitCommand(preview.target);
    command = `${shellQuote(unitBin)} ${args.map(shellQuote).join(" ")} | batcat --paging=always --style=plain --language=ini`;
  } else {
    const { real } = validatedPreviewFile(preview.target);
    command = `batcat --paging=always --style=plain ${shellQuote(real)} || less ${shellQuote(real)}`;
  }

  const child = spawn(alacritty, ["--hold", "-e", "sh", "-lc", command], {
    detached: true,
    stdio: "ignore",
    env: systemdEnv
  });
  child.unref();
  return { ok: true, kind: preview.kind, target: preview.target };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
  { id: "load1", label: "Load (1m)", query: 'srvls_loadavg{window="1m"}' },
  {
    id: "containers_running",
    label: "Containers running",
    query: 'sum(srvls_items{type="docker",state="running"})'
  },
  {
    id: "problems",
    label: "Problem units",
    query: "sum(srvls_unit_problem) or vector(0)"
  },
  {
    id: "usr_failed",
    label: "Failed user services",
    query: 'sum(srvls_items{type="usr-svc",state="failed"}) or vector(0)'
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
  await execFileAsync(SRVLS_BIN, [action, type, name], { env: systemdEnv, timeout: 60_000 });
  inventoryCache = null;
  return { ok: true, type, name, action };
}

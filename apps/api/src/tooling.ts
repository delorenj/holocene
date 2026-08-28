import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { load } from "js-yaml";
import { createClient } from "redis";

const HOME = homedir();
const REDIS_URL = process.env.TOOLING_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
export const TOOLING_STAT_TTL_SECONDS = Number(process.env.TOOLING_STAT_TTL_SECONDS ?? 60 * 60 * 24 * 30);
const AGENT_HOOK_REFRESH_MS = Number(process.env.AGENT_HOOK_HEALTH_REFRESH_MS ?? 60_000);

const PRIMARY_AGENT_CLIS = ["claude", "codex", "hermes", "opencode", "gemini", "kimi"] as const;
type AgentCli = (typeof PRIMARY_AGENT_CLIS)[number];

type JsonRecord = Record<string, unknown>;
type RedisClient = {
  isOpen: boolean;
  connect: () => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
  ttl: (key: string) => Promise<number>;
  set: (
    key: string,
    value: string,
    options: { expiration: { type: "EX"; value: number } }
  ) => Promise<unknown>;
  on: (event: "error", listener: (err: unknown) => void) => RedisClient;
};

export type ToolingStatHealth = "healthy" | "warning" | "critical" | "unknown";
export type ToolingStatTransport = "polling" | "sse";
export type ToolingStatKind = "number" | "duration" | "status" | "table" | "text";

export type ToolingStatDefinition = {
  id: string;
  title: string;
  description?: string;
  kind: ToolingStatKind;
  transport: ToolingStatTransport;
  redisKey: string;
  refreshMs?: number;
  presentation?: {
    chrome?: "default" | "minimal";
  };
};

export type ToolingStatSnapshot<T = unknown> = {
  id: string;
  value: T;
  status: ToolingStatHealth;
  observedAt?: string;
  expiresAt?: string;
  meta?: JsonRecord;
};

export type ToolingCollectionLayout = "grid" | "list";
export type ToolingCollectionSeverity = "ok" | "warning" | "critical" | "unknown";

export type ToolingCollectionView = {
  kind: "collection";
  layout: ToolingCollectionLayout;
  title?: string;
  variant?: string;
};

export type ToolingCollectionItem<TDetail = unknown> = {
  id: string;
  label: string;
  severity: ToolingCollectionSeverity;
  statusLabel?: string;
  summary?: string;
  sort?: number;
  detail?: TDetail;
};

export type AgentHookHealthEntry = {
  cli: AgentCli;
  normalizedHook: string;
  hook: string;
  command: string;
  ok: boolean;
  source: string;
  mappingSource?: "publisher" | "hook" | "local" | "missing" | "unsupported";
  matcher?: string;
  note?: string;
  relation?: string;
};

export type AgentHookHealthHookGroup = {
  id: string;
  hook: string;
  label: string;
  severity: ToolingCollectionSeverity;
  statusLabel: string;
  mappedTypes: string[];
  bloodbankMapped: number;
  failing: number;
  entries: AgentHookHealthEntry[];
};

export type AgentHookHealthItemDetail = {
  cli: AgentCli;
  commandCount: number;
  bloodbankMapped: number;
  failing: number;
  sources: string[];
  hooks: AgentHookHealthHookGroup[];
};

export type AgentHookHealthValue = {
  view: ToolingCollectionView;
  items: ToolingCollectionItem<AgentHookHealthItemDetail>[];
  summary: {
    total: number;
    ok: number;
    failing: number;
    configuredClis: number;
    expectedClis: number;
    missingClis: AgentCli[];
  };
  entries: AgentHookHealthEntry[];
};

const STAT_DEFINITIONS: ToolingStatDefinition[] = [
  {
    id: "agent-hook-health",
    title: "Agent Hook Health",
    description: "Latest configured hook commands across the primary 33GOD agent CLIs.",
    kind: "table",
    transport: "sse",
    redisKey: "holocene:tooling:stat:agent-hook-health",
    refreshMs: AGENT_HOOK_REFRESH_MS,
    presentation: {
      chrome: "minimal"
    }
  },
  {
    // Externally populated: bloodbank/services/agent-hooks health timer writes
    // this Redis key (functional pass/fail of every DEPLOYED hook config).
    // No collector here — getToolingStat serves it straight from Redis.
    id: "agent-hook-tests",
    title: "Agent Hook Tests",
    description: "Functional pass/fail of deployed agent hook configs (bloodbank agent-hooks healthcheck).",
    kind: "table",
    transport: "polling",
    redisKey: "holocene:tooling:stat:agent-hook-tests",
    refreshMs: 30_000,
    presentation: {
      chrome: "minimal"
    }
  }
];

// These are the types the CLI hook publishers actually emit today: the
// version-free grammar `bloodbank.<domain>.<entity>.<action>`. bb-emit rejects
// a 5-token type outright, so anything still shaped `bloodbank.v1.*` is history,
// never a live producer. Keep this map in step with the hooks SSOT — a stale
// entry here makes /api/modules/tooling report a normalizedHook nobody emits.
const BLOODBANK_HOOK_TYPES: Record<string, string> = {
  "claude:SessionStart": "bloodbank.agent.session.started",
  "claude:session-start": "bloodbank.agent.session.started",
  "claude:Stop": "bloodbank.agent.session.ended",
  "claude:session-end": "bloodbank.agent.session.ended",
  "claude:UserPromptSubmit": "bloodbank.conversation.turn.started",
  "claude:prompt-submitted": "bloodbank.conversation.turn.started",
  "claude:PreToolUse": "bloodbank.agent.tool.requested",
  "claude:tool-request": "bloodbank.agent.tool.requested",
  "claude:PostToolUse": "bloodbank.agent.tool.completed",
  "claude:tool-action": "bloodbank.agent.tool.completed",
  "claude:SubagentStop": "bloodbank.agent.invocation.completed",
  "claude:subagent-stopped": "bloodbank.agent.invocation.completed",
  "codex:SessionStart": "bloodbank.agent.session.started",
  "codex:session-start": "bloodbank.agent.session.started",
  "codex:Stop": "bloodbank.agent.session.ended",
  "codex:SessionEnd": "bloodbank.agent.session.ended",
  "codex:session-end": "bloodbank.agent.session.ended",
  "codex:UserPromptSubmit": "bloodbank.conversation.turn.started",
  "codex:prompt-submitted": "bloodbank.conversation.turn.started",
  "codex:PreToolUse": "bloodbank.agent.tool.requested",
  "codex:tool-request": "bloodbank.agent.tool.requested",
  "codex:PostToolUse": "bloodbank.agent.tool.completed",
  "codex:tool-action": "bloodbank.agent.tool.completed",
  "codex:tool-completed": "bloodbank.agent.tool.completed",
  "codex:SubagentStart": "bloodbank.agent.invocation.started",
  "codex:subagent-started": "bloodbank.agent.invocation.started",
  "codex:SubagentStop": "bloodbank.agent.invocation.completed",
  "codex:subagent-stopped": "bloodbank.agent.invocation.completed",
  "codex:notify": "bloodbank.conversation.turn.completed",
  "gemini:BeforeAgent": "bloodbank.agent.invocation.started",
  "gemini:AfterTool": "bloodbank.agent.tool.completed",
  "gemini:SessionEnd": "bloodbank.agent.session.ended"
};

const HOOK_RELATIONS: Record<string, string> = {
  "bloodbank.agent.session.started": "Starts the session root used by later correlation and causation links.",
  "bloodbank.agent.session.ended": "Closes the active agent session and archives the session chain.",
  "bloodbank.conversation.turn.started": "Starts a user prompt turn inside the active agent session.",
  "bloodbank.conversation.turn.completed": "Marks a conversation turn terminal inside the active session thread.",
  "bloodbank.agent.tool.requested": "Records the pre-execution tool request within the active invocation.",
  "bloodbank.agent.tool.completed": "Records the post-execution tool result within the active invocation.",
  "bloodbank.agent.invocation.started": "Starts a child or agent invocation linked to the active turn/session.",
  "bloodbank.agent.invocation.completed": "Completes a child or agent invocation linked to the active turn/session."
};

// TRANSITIONAL, and only on the read side. HOOK_RELATIONS is keyed by the
// version-free type, but a normalizedHook can still reach us in the retired
// 5-token `bloodbank.v1.*` shape — from a cached tooling stat written by an
// earlier deploy, or from a host whose hook config predates the rename. Looking
// those up literally would silently drop the relation string, so we compare the
// `<domain>.<entity>.<action>` tail instead. This is tolerance for HISTORY, not
// permission for a producer to emit the old shape: bb-emit rejects it at the
// source. Drop the strip once no pre-rename state is left in Redis.
const BLOODBANK_TYPE_PREFIX = /^bloodbank\.(evt\.|cmd\.|rpy\.)?v?[0-9]*\.?/;

function bloodbankTypeTail(value: string): string {
  return value.replace(BLOODBANK_TYPE_PREFIX, "");
}

const HOOK_RELATIONS_BY_TAIL = new Map(
  Object.entries(HOOK_RELATIONS).map(([type, relation]) => [bloodbankTypeTail(type), relation])
);

function hookRelation(normalizedHook: string | undefined): string | undefined {
  if (!normalizedHook) return undefined;
  return HOOK_RELATIONS_BY_TAIL.get(bloodbankTypeTail(normalizedHook));
}

const HOOK_HEALTH_COLLECTION_ORDER = ["claude", "hermes", "codex", "kimi", "gemini", "opencode"] as const satisfies readonly AgentCli[];
const AGENT_CLI_LABELS: Record<AgentCli, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  hermes: "Hermes",
  kimi: "Kimi",
  opencode: "OpenCode"
};

let redisClient: RedisClient | undefined;
let redisConnecting: Promise<RedisClient> | undefined;

function statDefinition(id: string) {
  return STAT_DEFINITIONS.find((definition) => definition.id === id);
}

async function getRedisClient() {
  if (redisClient?.isOpen) return redisClient;
  if (redisConnecting) return redisConnecting;

  const client = createClient({ url: REDIS_URL }) as unknown as RedisClient;
  client.on("error", () => undefined);
  redisConnecting = client
    .connect()
    .then(() => {
      redisClient = client;
      redisConnecting = undefined;
      return client;
    })
    .catch((err) => {
      redisConnecting = undefined;
      redisClient = undefined;
      throw err;
    });
  return redisConnecting;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function readJson(path: string): JsonRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function readYaml(path: string): JsonRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return asRecord(load(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function normalizeSnapshot(definition: ToolingStatDefinition, value: unknown, ttlSeconds?: number): ToolingStatSnapshot {
  const parsed = asRecord(value);
  const observedAt = typeof parsed?.observedAt === "string" ? parsed.observedAt : new Date().toISOString();
  const expiresAt =
    typeof parsed?.expiresAt === "string"
      ? parsed.expiresAt
      : ttlSeconds && ttlSeconds > 0
        ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
        : undefined;
  const status =
    parsed?.status === "healthy" ||
    parsed?.status === "warning" ||
    parsed?.status === "critical" ||
    parsed?.status === "unknown"
      ? parsed.status
      : "unknown";

  return {
    id: typeof parsed?.id === "string" ? parsed.id : definition.id,
    value: parsed && "value" in parsed ? parsed.value : null,
    status,
    observedAt,
    expiresAt,
    meta: asRecord(parsed?.meta) ?? { redisKey: definition.redisKey }
  };
}

function missingSnapshot(definition: ToolingStatDefinition, reason: string): ToolingStatSnapshot {
  return {
    id: definition.id,
    value: null,
    status: "unknown",
    observedAt: new Date().toISOString(),
    meta: {
      redisKey: definition.redisKey,
      reason
    }
  };
}

export function getToolingStatDefinitions() {
  return STAT_DEFINITIONS;
}

export async function getToolingStat(id: string): Promise<ToolingStatSnapshot> {
  const definition = statDefinition(id);
  if (!definition) return missingSnapshot({ id, title: id, kind: "text", transport: "polling", redisKey: "" }, "unknown stat");

  try {
    const client = await getRedisClient();
    const [raw, ttl] = await Promise.all([client.get(definition.redisKey), client.ttl(definition.redisKey)]);
    if (!raw) return missingSnapshot(definition, "Redis key is missing");
    return normalizeSnapshot(definition, JSON.parse(raw), ttl);
  } catch (err) {
    return missingSnapshot(definition, err instanceof Error ? err.message : "Redis read failed");
  }
}

export async function getToolingStats() {
  return {
    generatedAt: new Date().toISOString(),
    definitions: STAT_DEFINITIONS,
    stats: await Promise.all(STAT_DEFINITIONS.map((definition) => getToolingStat(definition.id)))
  };
}

async function setToolingStat(snapshot: ToolingStatSnapshot) {
  const definition = statDefinition(snapshot.id);
  if (!definition) throw new Error(`Unknown tooling stat: ${snapshot.id}`);
  const observedAt = snapshot.observedAt ?? new Date().toISOString();
  const expiresAt = new Date(Date.now() + TOOLING_STAT_TTL_SECONDS * 1000).toISOString();
  const payload = { ...snapshot, observedAt, expiresAt };
  const client = await getRedisClient();
  await client.set(definition.redisKey, JSON.stringify(payload), {
    expiration: { type: "EX", value: TOOLING_STAT_TTL_SECONDS }
  });
  return payload;
}

function configuredPath(path: string) {
  return path
    .replace(/\$\{HOME\}/g, HOME)
    .replace(/\$HOME/g, HOME)
    .replace(/^~/, HOME);
}

function displayCommand(command: string, env: Record<string, string>) {
  let out = command;
  for (const [key, value] of Object.entries(env)) {
    out = out.replace(new RegExp(`\\$\\{${key}\\}|\\$${key}\\b`, "g"), value);
  }
  return out.replaceAll(HOME, "~").replace(/\s+/g, " ").trim();
}

function sourceLabel(source: string) {
  return source.replace(HOME, "~");
}

function severityRank(severity: ToolingCollectionSeverity) {
  if (severity === "critical") return 3;
  if (severity === "warning") return 2;
  if (severity === "unknown") return 1;
  return 0;
}

function entrySeverity(entry: AgentHookHealthEntry): ToolingCollectionSeverity {
  if (entry.ok) return "ok";
  if (entry.mappingSource === "missing" && entry.cli !== "opencode") return "warning";
  return "critical";
}

function groupSeverity(entries: AgentHookHealthEntry[]): ToolingCollectionSeverity {
  if (!entries.length) return "unknown";
  return entries.reduce<ToolingCollectionSeverity>((severity, entry) => {
    const next = entrySeverity(entry);
    return severityRank(next) > severityRank(severity) ? next : severity;
  }, "ok");
}

function severityLabel(severity: ToolingCollectionSeverity) {
  if (severity === "critical") return "Fail";
  if (severity === "warning") return "Warn";
  if (severity === "unknown") return "Unknown";
  return "OK";
}

function commandToString(command: unknown): string {
  if (Array.isArray(command)) return command.map((part) => String(part)).join(" ");
  return typeof command === "string" ? command : "";
}

function extractCommandPaths(command: string, env: Record<string, string>) {
  const expanded = displayCommand(command, env).replace(/^~/, HOME).replaceAll(" ~/", ` ${HOME}/`);
  const paths = new Set<string>();
  const matches = expanded.matchAll(/(?:^|[\s"'=])((?:\/home\/delorenj|\/)[^\s"';|)]+)/g);

  for (const match of matches) {
    const path = match[1]
      ?.replace(/[),.:]+$/g, "")
      .replace(/^'/, "")
      .replace(/'$/, "");
    if (!path || path.includes("*") || path === "/") continue;
    paths.add(configuredPath(path));
  }

  return [...paths];
}

function publisherHookArg(cli: AgentCli, command: string, env: Record<string, string>) {
  const expanded = displayCommand(command, env);
  if (!expanded.includes("publish.py")) return undefined;
  const publishMatch = expanded.match(/publish\.py\s+([^\s"'|;&]+)/);
  const hookArg = publishMatch?.[1];
  if (!hookArg) {
    return {
      normalizedHook: "unsupported",
      ok: false,
      note: "publisher hook argument is missing",
      mappingSource: "unsupported" as const
    };
  }

  const normalizedHook = BLOODBANK_HOOK_TYPES[`${cli}:${hookArg}`];
  if (!normalizedHook) {
    return {
      normalizedHook: "unsupported",
      ok: false,
      note: `publisher does not map '${hookArg}' to a Bloodbank event type`,
      mappingSource: "unsupported" as const
    };
  }
  return {
    normalizedHook,
    ok: true,
    note: undefined,
    mappingSource: "publisher" as const,
    relation: hookRelation(normalizedHook)
  };
}

function localHookType(cli: AgentCli, hook: string) {
  const safeHook = hook
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `local.${cli}.${safeHook || "hook"}`;
}

function inferredHookMapping(cli: AgentCli, hook: string) {
  const normalizedHook = BLOODBANK_HOOK_TYPES[`${cli}:${hook}`];
  if (normalizedHook) {
    return {
      normalizedHook,
      mappingSource: "hook" as const,
      relation: hookRelation(normalizedHook)
    };
  }

  return {
    normalizedHook: localHookType(cli, hook),
    mappingSource: "local" as const,
    relation: "Local helper hook; no Bloodbank publisher is configured for this command."
  };
}

function commandHealth(cli: AgentCli, hook: string, command: string, env: Record<string, string>) {
  if (!command.trim()) {
    return {
      ...inferredHookMapping(cli, hook),
      ok: false,
      note: "hook command is empty"
    };
  }

  const paths = extractCommandPaths(command, env);
  const missingPaths = paths.filter((path) => !existsSync(path));
  const publisher = publisherHookArg(cli, command, env);
  const inferred = inferredHookMapping(cli, hook);
  const pathOk = missingPaths.length === 0;
  const ok = pathOk && (publisher?.ok ?? true);
  const normalizedHook =
    publisher?.normalizedHook && publisher.normalizedHook !== "unsupported"
      ? publisher.normalizedHook
      : inferred.normalizedHook;
  const relation = publisher?.relation ?? inferred.relation;

  return {
    normalizedHook,
    mappingSource: publisher?.mappingSource ?? inferred.mappingSource,
    ok,
    relation,
    note: [
      publisher?.note,
      missingPaths.length ? `missing path: ${missingPaths.map((path) => path.replace(HOME, "~")).join(", ")}` : undefined
    ]
      .filter(Boolean)
      .join("; ") || undefined
  };
}

function pushEntry(
  out: AgentHookHealthEntry[],
  cli: AgentCli,
  source: string,
  hook: string,
  command: unknown,
  env: Record<string, string>,
  matcher?: string
) {
  const rawCommand = commandToString(command);
  const health = commandHealth(cli, hook, rawCommand, env);
  out.push({
    cli,
    normalizedHook: health.normalizedHook,
    hook,
    command: rawCommand ? displayCommand(rawCommand, env) : "missing",
    ok: health.ok,
    source,
    mappingSource: health.mappingSource,
    matcher,
    note: health.note,
    relation: health.relation
  });
}

function walkHookValue(
  out: AgentHookHealthEntry[],
  cli: AgentCli,
  source: string,
  hook: string,
  value: unknown,
  env: Record<string, string>,
  matcher?: string
) {
  if (Array.isArray(value)) {
    for (const item of value) walkHookValue(out, cli, source, hook, item, env, matcher);
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  const nextMatcher = typeof record.matcher === "string" ? record.matcher : matcher;
  if ("command" in record || "bash" in record || "cmd" in record) {
    pushEntry(out, cli, source, hook, record.command ?? record.bash ?? record.cmd, env, nextMatcher);
  }
  if ("hooks" in record) walkHookValue(out, cli, source, hook, record.hooks, env, nextMatcher);
}

function collectJsonHooks(cli: AgentCli, source: string, hooks: unknown, env: Record<string, string>) {
  const out: AgentHookHealthEntry[] = [];
  const record = asRecord(hooks);
  if (!record) return out;

  for (const [hook, value] of Object.entries(record)) {
    walkHookValue(out, cli, source, hook, value, env);
  }

  return out;
}

function noHooksEntry(cli: AgentCli, source: string, note: string): AgentHookHealthEntry {
  return {
    cli,
    normalizedHook: `${localHookType(cli, "hooks")}.missing`,
    hook: "hooks",
    command: "none configured",
    ok: false,
    source,
    mappingSource: "missing",
    relation: "No hook config was found for this CLI.",
    note
  };
}

function collectClaudeHooks() {
  const source = `${HOME}/.claude/settings.json`;
  const config = readJson(source);
  const env = {
    HOME,
    HOOKS: typeof asRecord(config?.env)?.HOOKS === "string" ? String(asRecord(config?.env)?.HOOKS) : `${HOME}/.agents/hooks`
  };
  const entries = collectJsonHooks("claude", source, config?.hooks, env);
  return entries.length ? entries : [noHooksEntry("claude", source, "Claude settings has no hooks object")];
}

function collectCodexHooks() {
  const source = `${HOME}/.codex/hooks.json`;
  const config = readJson(source);
  const entries = collectJsonHooks("codex", source, config?.hooks, { HOME });
  return entries.length ? entries : [noHooksEntry("codex", source, "Codex hooks file has no hooks object")];
}

function collectGeminiHooks() {
  const source = `${HOME}/.gemini/settings.json`;
  const config = readJson(source);
  const entries = collectJsonHooks("gemini", source, config?.hooks, { HOME });
  return entries.length ? entries : [noHooksEntry("gemini", source, "Gemini settings has no hooks object")];
}

function collectHermesHooks() {
  const source = `${HOME}/.hermes/config.yaml`;
  const config = readYaml(source);
  const entries = collectJsonHooks("hermes", source, config?.hooks, { HOME });
  return entries.length ? entries : [noHooksEntry("hermes", source, "Hermes hooks are empty")];
}

function collectOpencodeHooks() {
  const source = `${HOME}/.config/opencode/opencode.json`;
  const config = readJson(source);
  const entries = collectJsonHooks("opencode", source, config?.hooks, { HOME });
  return entries.length ? entries : [noHooksEntry("opencode", source, "OpenCode config has no hooks object")];
}

function collectKimiHooks() {
  const source = `${HOME}/.kimi/config.toml`;
  if (!existsSync(source)) return [noHooksEntry("kimi", source, "Kimi config file is missing")];
  const raw = readFileSync(source, "utf8");
  const hooksLine = raw.match(/^\s*hooks\s*=\s*(.+)$/m)?.[1]?.trim();
  if (!hooksLine || hooksLine === "[]") return [noHooksEntry("kimi", source, "Kimi hooks are empty")];
  return [
    {
      cli: "kimi",
      normalizedHook: localHookType("kimi", "hooks"),
      hook: "hooks",
      command: hooksLine,
      ok: true,
      source,
      mappingSource: "local",
      relation: "Kimi hook config is present, but this collector does not expand each configured hook yet.",
      note: "Kimi hooks are configured but not expanded by the first collector pass"
    } satisfies AgentHookHealthEntry
  ];
}

function collectAgentHookEntries() {
  return [
    ...collectClaudeHooks(),
    ...collectCodexHooks(),
    ...collectHermesHooks(),
    ...collectOpencodeHooks(),
    ...collectGeminiHooks(),
    ...collectKimiHooks()
  ];
}

function buildHookGroups(entries: AgentHookHealthEntry[]): AgentHookHealthHookGroup[] {
  const groups = entries.reduce((out, entry) => {
    const group = out.get(entry.hook) ?? [];
    group.push(entry);
    out.set(entry.hook, group);
    return out;
  }, new Map<string, AgentHookHealthEntry[]>());

  return [...groups]
    .map(([hook, hookEntries]) => {
      const severity = groupSeverity(hookEntries);
      return {
        id: hook,
        hook,
        label: hook,
        severity,
        statusLabel: severityLabel(severity),
        mappedTypes: [...new Set(hookEntries.map((entry) => entry.normalizedHook))],
        bloodbankMapped: hookEntries.filter((entry) => entry.normalizedHook.startsWith("bloodbank.")).length,
        failing: hookEntries.filter((entry) => !entry.ok).length,
        entries: hookEntries
      };
    })
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.label.localeCompare(b.label));
}

function buildAgentHookHealthItems(entries: AgentHookHealthEntry[]) {
  const groups = entries.reduce((out, entry) => {
    const group = out.get(entry.cli) ?? [];
    group.push(entry);
    out.set(entry.cli, group);
    return out;
  }, new Map<AgentCli, AgentHookHealthEntry[]>());

  return HOOK_HEALTH_COLLECTION_ORDER.map<ToolingCollectionItem<AgentHookHealthItemDetail>>((cli, sort) => {
    const cliEntries = groups.get(cli) ?? [];
    const severity = groupSeverity(cliEntries);
    const bloodbankMapped = cliEntries.filter((entry) => entry.normalizedHook.startsWith("bloodbank.")).length;
    const failing = cliEntries.filter((entry) => !entry.ok).length;

    return {
      id: cli,
      label: AGENT_CLI_LABELS[cli],
      severity,
      statusLabel: severityLabel(severity),
      summary: cliEntries.length
        ? `${cliEntries.length} commands / ${bloodbankMapped} Bloodbank mapped`
        : "No hook rows collected",
      sort,
      detail: {
        cli,
        commandCount: cliEntries.length,
        bloodbankMapped,
        failing,
        sources: [...new Set(cliEntries.map((entry) => sourceLabel(entry.source)))],
        hooks: buildHookGroups(cliEntries)
      }
    };
  });
}

export async function refreshAgentHookHealthStat() {
  const entries = collectAgentHookEntries();
  const configured = new Set(entries.filter((entry) => entry.command !== "none configured").map((entry) => entry.cli));
  const missingClis = PRIMARY_AGENT_CLIS.filter((cli) => !configured.has(cli));
  const ok = entries.filter((entry) => entry.ok).length;
  const failing = entries.length - ok;
  const status: ToolingStatHealth =
    entries.length === 0 ? "unknown" : failing === 0 ? "healthy" : failing <= 3 ? "warning" : "critical";

  return setToolingStat({
    id: "agent-hook-health",
    status,
    observedAt: new Date().toISOString(),
    value: {
      view: {
        kind: "collection",
        layout: "grid",
        title: "Hook Health",
        variant: "hook-health-buttons"
      },
      items: buildAgentHookHealthItems(entries),
      summary: {
        total: entries.length,
        ok,
        failing,
        configuredClis: configured.size,
        expectedClis: PRIMARY_AGENT_CLIS.length,
        missingClis
      },
      entries
    } satisfies AgentHookHealthValue,
    meta: {
      redisKey: statDefinition("agent-hook-health")?.redisKey,
      ttlSeconds: TOOLING_STAT_TTL_SECONDS,
      source: "agent-hook-config-collector"
    }
  });
}

export async function refreshToolingStat(id: string) {
  if (id === "agent-hook-health") return refreshAgentHookHealthStat();
  // Externally-populated stats have no in-process collector — return whatever
  // the external writer (e.g. the bloodbank agent-hooks health timer) last set.
  if (id === "agent-hook-tests") return getToolingStat(id);
  throw new Error(`No refresh collector registered for tooling stat: ${id}`);
}

export function startToolingCollectors(log?: { info: (msg: string) => void; warn: (msg: string) => void }) {
  const run = () => {
    refreshAgentHookHealthStat()
      .then((snapshot) => log?.info(`refreshed tooling stat ${snapshot.id}`))
      .catch((err) =>
        log?.warn(`tooling stat refresh failed: ${err instanceof Error ? err.message : String(err)}`)
      );
  };

  run();
  const interval = setInterval(run, AGENT_HOOK_REFRESH_MS);
  interval.unref?.();
  return () => clearInterval(interval);
}

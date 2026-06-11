"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

type ToolingStatHealth = "healthy" | "warning" | "critical" | "unknown";
type ToolingStatTransport = "polling" | "sse";
type ToolingPanelChrome = "default" | "minimal";

type ToolingStatDefinition = {
  id: string;
  title: string;
  description?: string;
  kind: "number" | "duration" | "status" | "table" | "text";
  transport: ToolingStatTransport;
  redisKey: string;
  refreshMs?: number;
  presentation?: {
    chrome?: ToolingPanelChrome;
  };
};

type ToolingStatSnapshot<T = unknown> = {
  id: string;
  value: T;
  status: ToolingStatHealth;
  observedAt?: string;
  expiresAt?: string;
  meta?: Record<string, unknown>;
};

type ToolingCollectionLayout = "grid" | "list";
type ToolingCollectionSeverity = "ok" | "warning" | "critical" | "unknown";

type ToolingCollectionView = {
  kind: "collection";
  layout: ToolingCollectionLayout;
  title?: string;
  variant?: string;
};

type ToolingCollectionItem<TDetail = unknown> = {
  id: string;
  label: string;
  severity: ToolingCollectionSeverity;
  statusLabel?: string;
  summary?: string;
  sort?: number;
  detail?: TDetail;
};

type ToolingCollectionValue<TDetail = unknown> = {
  view: ToolingCollectionView;
  items: ToolingCollectionItem<TDetail>[];
};

type AgentHookHealthEntry = {
  cli: string;
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

type AgentHookHealthHookGroup = {
  id: string;
  hook: string;
  label: string;
  severity: ToolingCollectionSeverity;
  statusLabel?: string;
  mappedTypes: string[];
  bloodbankMapped: number;
  failing: number;
  entries: AgentHookHealthEntry[];
};

type AgentHookHealthItemDetail = {
  cli: string;
  commandCount: number;
  bloodbankMapped: number;
  failing: number;
  sources: string[];
  hooks: AgentHookHealthHookGroup[];
};

type AgentHookHealthValue = {
  view?: ToolingCollectionView;
  items?: ToolingCollectionItem<AgentHookHealthItemDetail>[];
  summary: {
    total: number;
    ok: number;
    failing: number;
    configuredClis: number;
    expectedClis: number;
    missingClis: string[];
  };
  entries: AgentHookHealthEntry[];
};

type DefinitionsResponse = {
  generatedAt: string;
  definitions: ToolingStatDefinition[];
};

type LiveStatPanelProps = {
  definition: ToolingStatDefinition;
  snapshot: ToolingStatSnapshot | null;
  mode: ToolingStatTransport;
  loading?: boolean;
  error?: string | null;
  children: ReactNode;
};

type CollectionRenderArgs<TDetail> = {
  item: ToolingCollectionItem<TDetail>;
  selected: boolean;
  onSelect: () => void;
};

type CollectionDetailArgs<TDetail> = {
  item: ToolingCollectionItem<TDetail>;
};

const FALLBACK_DEFINITIONS: ToolingStatDefinition[] = [
  {
    id: "agent-hook-health",
    title: "Agent Hook Health",
    description: "Latest configured hook commands across the primary 33GOD agent CLIs.",
    kind: "table",
    transport: "sse",
    redisKey: "holocene:tooling:stat:agent-hook-health",
    refreshMs: 60_000,
    presentation: {
      chrome: "minimal"
    }
  }
];

const CLI_ORDER = ["claude", "hermes", "codex", "kimi", "gemini", "opencode"];
const CLI_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  hermes: "Hermes",
  kimi: "Kimi",
  opencode: "OpenCode"
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function formatAge(iso?: string) {
  if (!iso) return "unknown";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTimeDistance(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatUntil(iso?: string) {
  if (!iso) return "unknown";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.floor((timestamp - Date.now()) / 1000);
  if (seconds >= 0) return `in ${formatTimeDistance(seconds)}`;
  return `${formatTimeDistance(Math.abs(seconds))} ago`;
}

function statusClass(status: ToolingStatHealth | undefined) {
  if (status === "healthy") return "status status-idle";
  if (status === "warning") return "status status-checking";
  if (status === "critical") return "status status-attention";
  return "status status-unknown";
}

function isToolingCollectionValue<TDetail = unknown>(value: unknown): value is ToolingCollectionValue<TDetail> {
  const record = asRecord(value);
  const view = asRecord(record?.view);
  return (
    !!record &&
    Array.isArray(record.items) &&
    view?.kind === "collection" &&
    (view.layout === "grid" || view.layout === "list")
  );
}

function isAgentHookHealthValue(value: unknown): value is AgentHookHealthValue {
  const record = asRecord(value);
  return !!record && Array.isArray(record.entries) && !!record.summary;
}

function cliLabel(cli: string) {
  return CLI_LABELS[cli] ?? cli;
}

function sourceLabel(source: string) {
  return source.replace(/^\/home\/delorenj/, "~");
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

function severityGlyph(severity: ToolingCollectionSeverity) {
  if (severity === "critical") return "x";
  if (severity === "warning") return "!";
  if (severity === "unknown") return "?";
  return "OK";
}

function mappingLabel(entry: AgentHookHealthEntry) {
  if (entry.mappingSource === "publisher") return "Publisher";
  if (entry.mappingSource === "hook") return "Hook lifecycle";
  if (entry.mappingSource === "local") return "Local";
  if (entry.mappingSource === "missing") return "Missing";
  if (entry.mappingSource === "unsupported") return "Unsupported";
  return "Mapped";
}

function safeClassSegment(value?: string) {
  return value ? value.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase() : "";
}

function buildFallbackHookGroups(entries: AgentHookHealthEntry[]): AgentHookHealthHookGroup[] {
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

function fallbackHookHealthCollection(value: AgentHookHealthValue): ToolingCollectionValue<AgentHookHealthItemDetail> {
  if (isToolingCollectionValue<AgentHookHealthItemDetail>(value)) return value;

  const configuredClis = [...new Set(value.entries.map((entry) => entry.cli))];
  const orderedClis = [...CLI_ORDER, ...configuredClis.filter((cli) => !CLI_ORDER.includes(cli))];

  return {
    view: {
      kind: "collection",
      layout: "grid",
      title: "Hook Health",
      variant: "hook-health-buttons"
    },
    items: orderedClis.map((cli, sort) => {
      const entries = value.entries.filter((entry) => entry.cli === cli);
      const severity = groupSeverity(entries);
      const bloodbankMapped = entries.filter((entry) => entry.normalizedHook.startsWith("bloodbank.")).length;

      return {
        id: cli,
        label: cliLabel(cli),
        severity,
        statusLabel: severityLabel(severity),
        summary: entries.length ? `${entries.length} commands / ${bloodbankMapped} Bloodbank mapped` : "No hook rows collected",
        sort,
        detail: {
          cli,
          commandCount: entries.length,
          bloodbankMapped,
          failing: entries.filter((entry) => !entry.ok).length,
          sources: [...new Set(entries.map((entry) => sourceLabel(entry.source)))],
          hooks: buildFallbackHookGroups(entries)
        }
      };
    })
  };
}

function sortCollectionItems<TDetail>(items: ToolingCollectionItem<TDetail>[]) {
  return [...items].sort(
    (a, b) => (a.sort ?? Number.MAX_SAFE_INTEGER) - (b.sort ?? Number.MAX_SAFE_INTEGER) || a.label.localeCompare(b.label)
  );
}

function DefaultCollectionResult<TDetail>({ item, selected, onSelect }: CollectionRenderArgs<TDetail>) {
  return (
    <button
      aria-pressed={selected}
      className={`stat-result-button stat-result-${item.severity}${selected ? " stat-result-selected" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <strong>{item.label}</strong>
      <span>{item.statusLabel ?? severityLabel(item.severity)}</span>
      {item.summary ? <small>{item.summary}</small> : null}
    </button>
  );
}

function DefaultCollectionDetail<TDetail>({ item }: CollectionDetailArgs<TDetail>) {
  return (
    <pre className="stat-json">
      {JSON.stringify(
        {
          id: item.id,
          label: item.label,
          severity: item.severity,
          detail: item.detail ?? null
        },
        null,
        2
      )}
    </pre>
  );
}

function StatCollectionView<TDetail>({
  className,
  emptyLabel = "No collection rows are available yet.",
  renderDetail = DefaultCollectionDetail,
  renderItem = DefaultCollectionResult,
  value
}: {
  className?: string;
  emptyLabel?: string;
  renderDetail?: (args: CollectionDetailArgs<TDetail>) => ReactNode;
  renderItem?: (args: CollectionRenderArgs<TDetail>) => ReactNode;
  value: ToolingCollectionValue<TDetail>;
}) {
  const items = useMemo(() => sortCollectionItems(value.items), [value.items]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const selectedItem = selectedItemId ? items.find((item) => item.id === selectedItemId) : undefined;
  const layoutClass = value.view.layout === "list" ? "stat-collection-list" : "stat-collection-grid";
  const variantClass = safeClassSegment(value.view.variant);

  useEffect(() => {
    if (!selectedItemId) return;
    if (items.some((item) => item.id === selectedItemId)) return;
    setSelectedItemId(null);
  }, [items, selectedItemId]);

  if (!items.length) return <div className="empty">{emptyLabel}</div>;

  return (
    <div
      className={[
        "stat-collection",
        layoutClass,
        variantClass ? `stat-collection-${variantClass}` : "",
        className ?? ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {value.view.title ? <h3 className="stat-collection-title">{value.view.title}</h3> : null}
      <div className="stat-collection-results" aria-label={value.view.title ?? "Stat collection"}>
        {items.map((item) =>
          renderItem({
            item,
            selected: selectedItem?.id === item.id,
            onSelect: () => setSelectedItemId(selectedItem?.id === item.id ? null : item.id)
          })
        )}
      </div>
      {selectedItem && renderDetail ? (
        <div className="stat-collection-detail" key={selectedItem.id}>
          {renderDetail({ item: selectedItem })}
        </div>
      ) : null}
    </div>
  );
}

function HookHealthResult({ item, selected, onSelect }: CollectionRenderArgs<AgentHookHealthItemDetail>) {
  return (
    <button
      aria-pressed={selected}
      className={`stat-result-button hook-health-result hook-severity-${item.severity}${selected ? " stat-result-selected" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span className={`hook-status-icon hook-status-${item.severity}`}>{severityGlyph(item.severity)}</span>
      <span className="hook-cli-name">{item.label}</span>
      <span className="hook-cli-status">{item.statusLabel ?? severityLabel(item.severity)}</span>
    </button>
  );
}

function HookHealthDetails({ item }: CollectionDetailArgs<AgentHookHealthItemDetail>) {
  const detail = item.detail;
  const hookGroups = detail?.hooks ?? [];
  const [selectedHookId, setSelectedHookId] = useState<string | null>(null);
  const selectedHookGroup = selectedHookId ? hookGroups.find((group) => group.id === selectedHookId) : undefined;
  const visibleHookGroups = hookGroups.some((group) => group.severity !== "ok")
    ? hookGroups.filter((group) => group.severity !== "ok")
    : hookGroups;

  useEffect(() => {
    if (!selectedHookId) return;
    if (hookGroups.some((group) => group.id === selectedHookId)) return;
    setSelectedHookId(null);
  }, [hookGroups, selectedHookId]);

  if (!detail) return <div className="empty">No detail row is available for {item.label}.</div>;

  return (
    <div className="hook-click-panel">
      <header className="hook-click-header">
        <div>
          <strong>{item.label}</strong>
          <span>
            {detail.commandCount} commands / {detail.bloodbankMapped} Bloodbank mapped
          </span>
        </div>
        <span className={`hook-mini-status hook-mini-${item.severity}`}>
          {item.statusLabel ?? severityLabel(item.severity)}
        </span>
      </header>
      <div className="hook-group-list" aria-label={`${item.label} hook status`}>
        {visibleHookGroups.map((group) => {
          const isSelected = selectedHookGroup?.id === group.id;
          return (
            <button
              aria-pressed={isSelected}
              className={`hook-group-row hook-severity-${group.severity}${isSelected ? " hook-group-row-selected" : ""}`}
              key={group.id}
              onClick={() => setSelectedHookId(isSelected ? null : group.id)}
              type="button"
            >
              <strong>{group.label}</strong>
              <span>{group.statusLabel ?? severityLabel(group.severity)}</span>
              <code>{group.mappedTypes[0] ?? "unmapped"}</code>
            </button>
          );
        })}
      </div>
      {selectedHookGroup ? (
        <div className="hook-detail" aria-label={`${selectedHookGroup.label} details`}>
          <strong>{selectedHookGroup.label}</strong>
          {selectedHookGroup.entries.map((entry) => (
            <dl key={`${entry.cli}-${entry.hook}-${entry.matcher ?? "all"}-${entry.command}`}>
              <div>
                <dt>Mapped to</dt>
                <dd>
                  <code>{entry.normalizedHook}</code>
                </dd>
              </div>
              <div>
                <dt>Relation</dt>
                <dd>{entry.relation ?? mappingLabel(entry)}</dd>
              </div>
              {entry.note ? (
                <div>
                  <dt>Note</dt>
                  <dd>{entry.note}</dd>
                </div>
              ) : null}
              <details>
                <summary>Command</summary>
                <code>{entry.command}</code>
                <code>{sourceLabel(entry.source)}</code>
              </details>
            </dl>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AgentHookHealthCollection({ value }: { value: AgentHookHealthValue }) {
  return (
    <StatCollectionView
      className="hook-health-collection"
      emptyLabel="Agent hook health is not available in Redis yet."
      renderDetail={(args) => <HookHealthDetails {...args} />}
      renderItem={(args) => <HookHealthResult {...args} />}
      value={fallbackHookHealthCollection(value)}
    />
  );
}

export function LiveStatPanel({
  definition,
  snapshot,
  mode,
  loading = false,
  error,
  children
}: LiveStatPanelProps) {
  const chrome = definition.presentation?.chrome ?? "default";

  if (chrome === "minimal") {
    return <article className="stat-card stat-card-minimal">{error ? <div className="empty">Tooling feed unavailable: {error}</div> : children}</article>;
  }

  return (
    <article className="stat-card">
      <header className="stat-card-header">
        <div>
          <h2>{definition.title}</h2>
          {definition.description ? <p className="section-note">{definition.description}</p> : null}
        </div>
        <span className={statusClass(snapshot?.status)}>{snapshot?.status ?? (loading ? "loading" : "unknown")}</span>
      </header>
      <div className="stat-card-meta">
        <span>{mode.toUpperCase()}</span>
        <span>{snapshot?.observedAt ? `observed ${formatAge(snapshot.observedAt)}` : "not observed"}</span>
        <span>{snapshot?.expiresAt ? `expires ${formatUntil(snapshot.expiresAt)}` : "ttl unknown"}</span>
        <span>{definition.redisKey}</span>
      </div>
      {error ? <div className="empty">Tooling feed unavailable: {error}</div> : children}
    </article>
  );
}

export function PollingStatCard({
  apiBase,
  definition,
  renderValue
}: {
  apiBase: string;
  definition: ToolingStatDefinition;
  renderValue: (snapshot: ToolingStatSnapshot | null) => ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<ToolingStatSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/api/modules/tooling/stats/${encodeURIComponent(definition.id)}`);
        if (!response.ok) throw new Error(`stat ${response.status}`);
        const data = (await response.json()) as ToolingStatSnapshot;
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "stat unavailable");
          setLoading(false);
        }
      }
    };

    void load();
    const interval = window.setInterval(() => {
      void load();
    }, definition.refreshMs ?? 15_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [apiBase, definition.id, definition.refreshMs]);

  return (
    <LiveStatPanel definition={definition} error={error} loading={loading} mode="polling" snapshot={snapshot}>
      {renderValue(snapshot)}
    </LiveStatPanel>
  );
}

export function SSEStatCard({
  apiBase,
  definition,
  renderValue
}: {
  apiBase: string;
  definition: ToolingStatDefinition;
  renderValue: (snapshot: ToolingStatSnapshot | null) => ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<ToolingStatSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadOnce = async () => {
      try {
        const response = await fetch(`${apiBase}/api/modules/tooling/stats/${encodeURIComponent(definition.id)}`);
        if (!response.ok) throw new Error(`stat ${response.status}`);
        const data = (await response.json()) as ToolingStatSnapshot;
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "stat unavailable");
          setLoading(false);
        }
      }
    };

    void loadOnce();

    const es = new EventSource(
      `${apiBase}/api/modules/tooling/stream?stat_id=${encodeURIComponent(definition.id)}`
    );
    es.addEventListener("tooling-stat", (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as ToolingStatSnapshot;
      setSnapshot(data);
      setError(null);
      setLoading(false);
    });
    es.onerror = () => {
      void loadOnce();
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, [apiBase, definition.id]);

  return (
    <LiveStatPanel definition={definition} error={error} loading={loading} mode="sse" snapshot={snapshot}>
      {renderValue(snapshot)}
    </LiveStatPanel>
  );
}

function renderStatValue(_definition: ToolingStatDefinition, snapshot: ToolingStatSnapshot | null) {
  if (isAgentHookHealthValue(snapshot?.value)) return <AgentHookHealthCollection value={snapshot.value} />;
  if (isToolingCollectionValue(snapshot?.value)) return <StatCollectionView value={snapshot.value} />;
  return <pre className="stat-json">{JSON.stringify(snapshot?.value ?? null, null, 2)}</pre>;
}

export function ToolingTab({ apiBase }: { apiBase: string }) {
  const [definitions, setDefinitions] = useState<ToolingStatDefinition[]>(FALLBACK_DEFINITIONS);
  const [definitionError, setDefinitionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadDefinitions = async () => {
      try {
        const response = await fetch(`${apiBase}/api/modules/tooling/definitions`);
        if (!response.ok) throw new Error(`definitions ${response.status}`);
        const data = (await response.json()) as DefinitionsResponse;
        if (!cancelled) {
          setDefinitions(data.definitions.length ? data.definitions : FALLBACK_DEFINITIONS);
          setDefinitionError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setDefinitionError(err instanceof Error ? err.message : "definitions unavailable");
        }
      }
    };

    void loadDefinitions();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  const sortedDefinitions = useMemo(
    () => [...definitions].sort((a, b) => a.title.localeCompare(b.title)),
    [definitions]
  );

  return (
    <section className="tooling-section" aria-label="Tooling">
      <div className="section-heading">
        <div>
          <h2>Tooling</h2>
          <p className="section-note">Redis-backed health stats for the 33GOD pipeline.</p>
        </div>
        {definitionError ? <span>definitions: {definitionError}</span> : null}
      </div>
      <div className="tooling-grid">
        {sortedDefinitions.map((definition) =>
          definition.transport === "sse" ? (
            <SSEStatCard
              apiBase={apiBase}
              definition={definition}
              key={definition.id}
              renderValue={(snapshot) => renderStatValue(definition, snapshot)}
            />
          ) : (
            <PollingStatCard
              apiBase={apiBase}
              definition={definition}
              key={definition.id}
              renderValue={(snapshot) => renderStatValue(definition, snapshot)}
            />
          )
        )}
      </div>
    </section>
  );
}

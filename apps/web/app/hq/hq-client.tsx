"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BridgeStatus, EmployeeStatus, OrgNode, OrgTree } from "@holocene/org-model";

type Tone = "working" | "idle" | "attention" | "failed" | "unknown";

type ActionResult = { ok: boolean; status: number; data: any };
type PostAction = (path: string, body?: unknown) => Promise<ActionResult>;
type GetAction = (path: string) => Promise<ActionResult>;
type Controls = { postAction: PostAction; getAction: GetAction; refresh: () => void };

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; tree: OrgTree; at: number }
  | { kind: "not-configured" }
  | { kind: "no-telegram" }
  | { kind: "unauthorized"; reason?: string }
  | { kind: "error"; message: string };

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

type TelegramWebApp = {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  openTelegramLink?: (url: string) => void;
  HapticFeedback?: { impactOccurred?: (style: string) => void };
};

const POLL_MS = 5000;
const SDK_SRC = "https://telegram.org/js/telegram-web-app.js";

function toneOf(status: EmployeeStatus): Tone {
  switch (status) {
    case "working":
    case "initializing":
    case "onboarding":
      return "working";
    case "idle":
      return "idle";
    case "blocked":
      return "attention";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

function loadTelegramSdk(): Promise<TelegramWebApp | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.Telegram?.WebApp) return Promise.resolve(window.Telegram.WebApp);

  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_SRC}"]`);
    const done = () => resolve(window.Telegram?.WebApp ?? null);
    if (existing) {
      existing.addEventListener("load", done, { once: true });
      existing.addEventListener("error", () => resolve(null), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    script.addEventListener("load", done, { once: true });
    script.addEventListener("error", () => resolve(null), { once: true });
    document.head.appendChild(script);
  });
}

function ageLabel(node: OrgNode): string {
  const secs = node.live?.activeWork?.ageSeconds;
  if (typeof secs !== "number" || !Number.isFinite(secs)) return "";
  if (secs < 60) return `${Math.round(secs)}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function moodGlyph(attention: number, total: number): string {
  if (total === 0) return "•";
  if (attention === 0) return "☀";
  if (attention / total < 0.2) return "⛅";
  return "⛈";
}

function openDm(botUsername?: string) {
  if (!botUsername) return;
  const url = `https://t.me/${botUsername}`;
  const tg = typeof window !== "undefined" ? window.Telegram?.WebApp : undefined;
  if (tg?.openTelegramLink) tg.openTelegramLink(url);
  else if (typeof window !== "undefined") window.open(url, "_blank", "noopener");
}

// Flatten every agent node with its department for lookups / attention band.
function collectAgents(tree: OrgTree): { node: OrgNode; deptName: string }[] {
  const out: { node: OrgNode; deptName: string }[] = [];
  for (const dept of tree.root.children ?? []) {
    for (const agent of dept.children ?? []) out.push({ node: agent, deptName: dept.displayName });
  }
  return out;
}

export default function HqClient() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const initDataRef = useRef<string>("");
  const fetchOnceRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // One org-tree fetch, no rescheduling — safe to call on demand (refresh).
    const fetchOnce = async () => {
      try {
        const res = await fetch("/hq/api/org-tree", {
          headers: initDataRef.current ? { authorization: `tma ${initDataRef.current}` } : {},
          cache: "no-store"
        });
        if (cancelled) return;
        if (res.status === 503) {
          setState({ kind: "not-configured" });
        } else if (res.status === 401) {
          let reason: string | undefined;
          try {
            reason = ((await res.json()) as { reason?: string })?.reason;
          } catch {
            /* non-JSON body */
          }
          setState(initDataRef.current ? { kind: "unauthorized", reason } : { kind: "no-telegram" });
        } else if (!res.ok) {
          setState({ kind: "error", message: `Fleet API returned ${res.status}` });
        } else {
          const tree = (await res.json()) as OrgTree;
          if (!cancelled) setState({ kind: "ok", tree, at: Date.now() });
        }
      } catch (err) {
        if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    };
    fetchOnceRef.current = () => {
      fetchOnce().catch(() => undefined);
    };

    const loop = async () => {
      await fetchOnce();
      if (!cancelled) timer = setTimeout(loop, POLL_MS);
    };

    (async () => {
      const tg = await loadTelegramSdk();
      if (cancelled) return;
      if (tg) {
        try {
          tg.ready?.();
          tg.expand?.();
          tg.setHeaderColor?.("#0b1020");
          tg.setBackgroundColor?.("#0b1020");
        } catch {
          /* older webview — non-fatal */
        }
        initDataRef.current = tg.initData ?? "";
      }
      loop();
    })();

    return () => {
      cancelled = true;
      fetchOnceRef.current = null;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const postAction = useCallback<PostAction>(async (path, body) => {
    const res = await fetch("/hq/api/action", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(initDataRef.current ? { authorization: `tma ${initDataRef.current}` } : {})
      },
      body: JSON.stringify({ path, body: body ?? {} }),
      cache: "no-store"
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON */
    }
    return { ok: res.ok, status: res.status, data };
  }, []);

  const getAction = useCallback<GetAction>(async (path) => {
    const res = await fetch(`/hq/api/action?path=${encodeURIComponent(path)}`, {
      headers: initDataRef.current ? { authorization: `tma ${initDataRef.current}` } : {},
      cache: "no-store"
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON */
    }
    return { ok: res.ok, status: res.status, data };
  }, []);

  const refresh = useCallback(() => fetchOnceRef.current?.(), []);
  const controls: Controls = useMemo(() => ({ postAction, getAction, refresh }), [postAction, getAction, refresh]);

  if (state.kind === "loading") {
    return (
      <main className="hq-shell">
        <div className="hq-banner">Loading the floor…</div>
      </main>
    );
  }

  if (state.kind === "not-configured") {
    return (
      <main className="hq-shell">
        <div className="hq-banner hq-banner-attention">
          <strong>DeloHQ isn’t wired up yet.</strong>
          <br />
          Create the <strong>@DeloHQBot</strong> in BotFather and set <code>TELEGRAM_HQ_BOT_TOKEN</code> on the
          Holocene web service, then reopen.
        </div>
      </main>
    );
  }

  if (state.kind === "no-telegram") {
    return (
      <main className="hq-shell">
        <div className="hq-banner">
          <strong>Open this from Telegram.</strong>
          <br />
          DeloHQ is a Telegram Mini App — launch it from the <strong>@DeloHQBot</strong> menu button so it can
          prove who you are. (The page loads fine here, but the org data stays locked without a valid Telegram
          session.)
        </div>
      </main>
    );
  }

  if (state.kind === "unauthorized") {
    const reasonCopy: Record<string, string> = {
      "user not allowed": "This Telegram account isn’t on the DeloHQ operator allowlist.",
      "bad signature": "The Mini App launch data didn’t verify. Fully close and reopen from @DeLoHQBot’s “Open HQ” menu button; if it persists, the server bot token may be misconfigured.",
      "expired initData": "This session is stale (>24h). Fully close and reopen the Mini App from @DeLoHQBot.",
      "missing user": "Telegram didn’t include your account in the launch data. Reopen from the @DeLoHQBot menu button.",
      "missing initData": "No Telegram launch data was sent. Open this from the @DeLoHQBot menu button, not a browser."
    };
    const detail = state.reason ? reasonCopy[state.reason] ?? `Verification failed: ${state.reason}.` : "This Telegram account isn’t on the DeloHQ operator allowlist.";
    return (
      <main className="hq-shell">
        <div className="hq-banner hq-banner-attention">
          <strong>Not authorized.</strong>
          <br />
          {detail}
          {state.reason ? <span className="hq-auth-reason"> (reason: {state.reason})</span> : null}
        </div>
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main className="hq-shell">
        <div className="hq-banner hq-banner-attention">
          <strong>Couldn’t reach the fleet.</strong>
          <br />
          {state.message}
        </div>
      </main>
    );
  }

  return <Constellation tree={state.tree} at={state.at} controls={controls} />;
}

function Sparkline({ data }: { data?: number[] }) {
  const values = data ?? [];
  const has = values.some((v) => v > 0);
  if (!has) return <span className="hq-spark-empty">no ticket velocity yet</span>;
  const max = Math.max(...values, 1);
  const w = 96;
  const h = 22;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(" ");
  return (
    <svg className="hq-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--blue)" strokeWidth="1.5" />
    </svg>
  );
}

function StatusDot({ tone }: { tone: Tone }) {
  return <span className={`hq-dot hq-dot-${tone}`} />;
}

function AgentNode({ node, deptName, onOpen }: { node: OrgNode; deptName: string; onOpen: (n: OrgNode, dept: string) => void }) {
  const tone = toneOf(node.status);
  const isManager = node.employeeRole === "manager";
  return (
    <button
      type="button"
      className={`hq-node hq-node-${tone}${isManager ? " hq-node-manager" : ""}${tone === "attention" ? " hq-node-ring" : ""}`}
      onClick={() => onOpen(node, deptName)}
    >
      <span className="hq-node-head">
        <StatusDot tone={tone} />
        <span className="hq-node-name">{node.displayName || node.id}</span>
        {isManager ? <span className="hq-node-badge">lead</span> : null}
      </span>
      <span className="hq-node-sub">
        <span className="hq-node-repo">{node.agentRef?.repo || node.id}</span>
        {node.flags?.includes("bridge-bound") ? (
          <span className="hq-node-bridge" title="Bound to the Plane bridge — reacts to its board">
            ⚡
          </span>
        ) : null}
        <span className="hq-node-state">{node.status}</span>
      </span>
    </button>
  );
}

function Constellation({ tree, at, controls }: { tree: OrgTree; at: number; controls: Controls }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const departments = useMemo(() => [...(tree.root.children ?? [])].sort((a, b) => a.order - b.order), [tree.root.children]);
  const everyone = useMemo(() => collectAgents(tree), [tree]);
  const attention = useMemo(
    () => everyone.filter((e) => toneOf(e.node.status) === "attention" || toneOf(e.node.status) === "failed"),
    [everyone]
  );
  const working = useMemo(() => everyone.filter((e) => toneOf(e.node.status) === "working"), [everyone]);
  // Re-derive the open agent from the current tree by id so the Office sheet
  // reflects live polls + control-action results without being reopened.
  const selected = useMemo(
    () => (selectedId ? everyone.find((e) => e.node.id === selectedId) ?? null : null),
    [selectedId, everyone]
  );

  const totals = tree.totals ?? { agents: 0, working: 0, idle: 0, needsAttention: 0, unknown: 0 };
  const updated = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const open = (node: OrgNode, _deptName: string) => setSelectedId(node.id);

  return (
    <main className="hq-shell">
      <header className="hq-top">
        <div>
          <p className="hq-eyebrow">{tree.company?.name || "Company"}</p>
          <h1>The Org</h1>
        </div>
        <span className="hq-mood" title="Company mood">
          {moodGlyph(totals.needsAttention, totals.agents)}
        </span>
      </header>

      {tree.bridge ? <BridgeCard bridge={tree.bridge} controls={controls} /> : null}

      {/* CEO node at the top of the constellation */}
      <div className="hq-ceo-wrap">
        <div className="hq-ceo-node">
          <span className="hq-ceo-avatar">{(tree.root.displayName || "?").slice(0, 1).toUpperCase()}</span>
          <span className="hq-ceo-name">{tree.root.displayName}</span>
          <span className="hq-ceo-title">{tree.root.title}</span>
        </div>
        <span className="hq-trunk" aria-hidden />
      </div>

      <section className="hq-metrics">
        <div className="hq-metric">
          <span>Agents</span>
          <strong>{totals.agents}</strong>
        </div>
        <div className="hq-metric hq-metric-working">
          <span>Working</span>
          <strong>{totals.working}</strong>
        </div>
        <div className="hq-metric hq-metric-attention">
          <span>Needs attn</span>
          <strong>{totals.needsAttention}</strong>
        </div>
        <div className="hq-metric">
          <span>Offline</span>
          <strong>{totals.unknown}</strong>
        </div>
      </section>

      {attention.length ? (
        <section className="hq-attn">
          <p className="hq-attn-label">▲ Needs attention</p>
          <div className="hq-attn-row">
            {attention.map(({ node, deptName }) => (
              <button key={node.id} type="button" className="hq-attn-chip" onClick={() => open(node, deptName)}>
                <StatusDot tone={toneOf(node.status)} />
                {node.displayName || node.id}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {working.length ? (
        <p className="hq-ticker">
          ⚡ Right now: {working.map((w) => w.node.displayName || w.node.id).join(" · ")}
        </p>
      ) : null}

      {tree.unmapped?.length ? (
        <div className="hq-banner hq-banner-attention hq-unmapped">
          {tree.unmapped.length} unmapped agent{tree.unmapped.length === 1 ? "" : "s"} in Unassigned — add{" "}
          {tree.unmapped.length === 1 ? "it" : "them"} to <code>~/.hermes/org.yaml</code>.
        </div>
      ) : null}

      <section className="hq-clusters">
        {departments.map((dept) => {
          const roll = dept.rollup ?? { agents: 0, working: 0, needsAttention: 0 };
          const manager = (dept.children ?? []).find((c) => c.employeeRole === "manager");
          const contributors = (dept.children ?? []).filter((c) => c.employeeRole !== "manager");
          return (
            <section key={dept.id} className="hq-cluster">
              <div className="hq-cluster-head">
                <span className="hq-cluster-name">{dept.displayName}</span>
                <span className="hq-cluster-roll">
                  <span className="hq-pip">{roll.agents}</span>
                  {roll.working ? <span className="hq-pip hq-pip-working">{roll.working} working</span> : null}
                  {roll.needsAttention ? <span className="hq-pip hq-pip-attention">{roll.needsAttention} attn</span> : null}
                </span>
              </div>
              {manager ? <AgentNode node={manager} deptName={dept.displayName} onOpen={open} /> : null}
              {contributors.length ? (
                <div className="hq-cluster-grid">
                  {contributors.map((agent) => (
                    <AgentNode key={agent.id} node={agent} deptName={dept.displayName} onOpen={open} />
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </section>

      <p className="hq-foot">
        {totals.agents} agents · {departments.length} departments · updated {updated} · refreshes every 5s
      </p>

      {selected ? <Office entry={selected} onClose={() => setSelectedId(null)} controls={controls} /> : null}
    </main>
  );
}

function BridgeCard({ bridge, controls }: { bridge: BridgeStatus; controls: Controls }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const up = bridge.serviceStatus === "active";
  const tone: Tone = up ? (bridge.healthOk ? "idle" : "attention") : "failed";
  const statusLabel = up ? (bridge.healthOk ? "live" : "no health") : bridge.serviceStatus;

  const run = async (key: string, path: string, body?: unknown) => {
    setBusy(key);
    setErr(null);
    const r = await controls.postAction(path, body);
    setBusy(null);
    if (!r.ok) setErr(r.data?.error || r.data?.message || `HTTP ${r.status}`);
    else controls.refresh();
  };

  return (
    <section className="hq-bridge">
      <div className="hq-bridge-head">
        <span className="hq-bridge-title">
          <StatusDot tone={tone} /> Plane bridge
        </span>
        <span className={`hq-pill hq-pill-${tone}`}>{statusLabel}</span>
      </div>
      <p className="hq-bridge-meta">
        {bridge.scope === "fleet"
          ? "Fleet — every mapped PM reacts to its board"
          : `Pilot — ${bridge.boundRepos.length} PM${bridge.boundRepos.length === 1 ? "" : "s"} bound`}
        {" · "}
        {bridge.projectsMapped} projects mapped {" · "}:{bridge.port}
      </p>
      {bridge.scope === "pilot" && bridge.boundRepos.length ? (
        <div className="hq-bridge-repos">
          {bridge.boundRepos.map((r) => (
            <span key={r} className="hq-chip">
              {r}
            </span>
          ))}
        </div>
      ) : null}
      {err ? <p className="hq-bridge-err">{err}</p> : null}
      <div className="hq-bridge-actions">
        <button
          type="button"
          className="hq-btn"
          disabled={!!busy}
          onClick={() => run("restart", "/api/modules/hermes-fleet/bridge/service/restart")}
        >
          {busy === "restart" ? "…" : "Restart"}
        </button>
        {up ? (
          <button
            type="button"
            className="hq-btn hq-btn-danger"
            disabled={!!busy}
            onClick={() => run("stop", "/api/modules/hermes-fleet/bridge/service/stop")}
          >
            {busy === "stop" ? "…" : "Stop"}
          </button>
        ) : (
          <button
            type="button"
            className="hq-btn"
            disabled={!!busy}
            onClick={() => run("start", "/api/modules/hermes-fleet/bridge/service/start")}
          >
            {busy === "start" ? "…" : "Start"}
          </button>
        )}
        {bridge.scope === "pilot" ? (
          <button
            type="button"
            className="hq-btn hq-btn-primary"
            disabled={!!busy}
            onClick={() => run("fleet", "/api/modules/hermes-fleet/bridge/binding", { scope: "fleet" })}
          >
            {busy === "fleet" ? "…" : "Roll fleet-wide →"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function Office({
  entry,
  onClose,
  controls
}: {
  entry: { node: OrgNode; deptName: string };
  onClose: () => void;
  controls: Controls;
}) {
  const { node, deptName } = entry;
  const tone = toneOf(node.status);
  const work = node.live?.activeWork;
  const summary = work?.summary || work?.reason || "";
  const bot = node.agentRef?.botUsername;
  const expertise = node.metadata?.expertise ?? [];
  const binding = node.live?.planeBinding;
  const repo = node.agentRef?.repo;

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);

  const run = async (key: string, path: string, body?: unknown) => {
    setBusy(key);
    setErr(null);
    const r = await controls.postAction(path, body);
    setBusy(null);
    if (!r.ok) setErr(r.data?.error || r.data?.message || `HTTP ${r.status}`);
    else controls.refresh();
  };

  const viewLog = async () => {
    setBusy("log");
    setErr(null);
    const r = await controls.getAction(`/api/modules/hermes-fleet/agents/${node.id}/log?lines=80`);
    setBusy(null);
    if (!r.ok) setErr(r.data?.error || `HTTP ${r.status}`);
    else setLog(typeof r.data?.content === "string" ? r.data.content : JSON.stringify(r.data, null, 2));
  };

  return (
    <div className="hq-sheet-backdrop" onClick={onClose}>
      <div className="hq-sheet" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <div className="hq-sheet-grip" />
        <div className="hq-sheet-head">
          <StatusDot tone={tone} />
          <div className="hq-sheet-id">
            <span className="hq-sheet-name">{node.displayName || node.id}</span>
            <span className="hq-sheet-title">
              {node.title}
              {node.employeeRole === "manager" ? " · lead" : ""} · {deptName}
            </span>
          </div>
          <span className={`hq-pill hq-pill-${tone}`}>{node.status}</span>
        </div>

        <div className="hq-sheet-meta">
          <span className="hq-sheet-repo">{node.agentRef?.repo || node.id}</span>
          {node.agentRef?.planeIdentifier ? <span className="hq-sheet-plane">{node.agentRef.planeIdentifier}</span> : null}
        </div>

        <div className="hq-sheet-block">
          <span className="hq-sheet-k">Current task</span>
          <span className="hq-sheet-v">
            {summary || "—"}
            {work?.issueId ? <span className="hq-sheet-issue"> {work.issueId}</span> : null}
          </span>
        </div>

        <div className="hq-sheet-block">
          <span className="hq-sheet-k">Heartbeat</span>
          <span className="hq-sheet-v">{ageLabel(node) || "no heartbeat yet"}</span>
        </div>

        <div className="hq-sheet-block">
          <span className="hq-sheet-k">Ticket velocity · 7d</span>
          <span className="hq-sheet-v">
            <Sparkline data={node.live?.sparkline} />
          </span>
        </div>

        {expertise.length ? (
          <div className="hq-sheet-tags">
            {expertise.map((x) => (
              <span key={x} className="hq-tag">
                {x}
              </span>
            ))}
          </div>
        ) : null}

        {binding?.bindable ? (
          <div className="hq-sheet-block">
            <span className="hq-sheet-k">Plane bridge</span>
            <div className="hq-ctl-row">
              <span className="hq-sheet-v">
                {binding.bound ? "Bound — reacts to its board" : "Not bound"}
                {binding.identifier ? ` · ${binding.identifier}` : ""}
              </span>
              <button
                type="button"
                className={`hq-btn ${binding.bound ? "hq-btn-danger" : "hq-btn-primary"}`}
                disabled={!!busy || !repo}
                onClick={() =>
                  run("bind", "/api/modules/hermes-fleet/bridge/binding", { repo, bound: !binding.bound })
                }
              >
                {busy === "bind" ? "…" : binding.bound ? "Unbind" : "Bind"}
              </button>
            </div>
          </div>
        ) : null}

        <div className="hq-sheet-block">
          <span className="hq-sheet-k">Services</span>
          {(["gateway", "consumer", "sentinel"] as const).map((svc) => (
            <div key={svc} className="hq-ctl-row">
              <span className="hq-ctl-name">{svc}</span>
              <div className="hq-ctl-btns">
                {(["start", "restart", "stop"] as const).map((act) => (
                  <button
                    key={act}
                    type="button"
                    className={`hq-btn hq-btn-sm${act === "stop" ? " hq-btn-danger" : ""}`}
                    disabled={!!busy}
                    onClick={() => run(`${svc}:${act}`, `/api/modules/hermes-fleet/agents/${node.id}/services/${svc}/${act}`)}
                  >
                    {busy === `${svc}:${act}` ? "…" : act}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="hq-sheet-block">
          <span className="hq-sheet-k">Sentinel log</span>
          {log ? (
            <pre className="hq-log">{log}</pre>
          ) : (
            <button type="button" className="hq-btn" disabled={!!busy} onClick={viewLog}>
              {busy === "log" ? "…" : "View last 80 lines"}
            </button>
          )}
        </div>

        {err ? <p className="hq-bridge-err">{err}</p> : null}

        <button type="button" className="hq-dm" disabled={!bot} onClick={() => openDm(bot)}>
          {bot ? "Open DM →" : "No bot linked"}
        </button>
      </div>
    </div>
  );
}

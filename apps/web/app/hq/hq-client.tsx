"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EmployeeStatus, OrgNode, OrgTree } from "@holocene/org-model";

type Tone = "working" | "idle" | "attention" | "failed" | "unknown";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; tree: OrgTree; at: number }
  | { kind: "not-configured" }
  | { kind: "no-telegram" }
  | { kind: "unauthorized" }
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

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const res = await fetch("/hq/api/org-tree", {
          headers: initDataRef.current ? { authorization: `tma ${initDataRef.current}` } : {},
          cache: "no-store"
        });
        if (cancelled) return;
        if (res.status === 503) {
          setState({ kind: "not-configured" });
        } else if (res.status === 401) {
          setState(initDataRef.current ? { kind: "unauthorized" } : { kind: "no-telegram" });
        } else if (!res.ok) {
          setState({ kind: "error", message: `Fleet API returned ${res.status}` });
        } else {
          const tree = (await res.json()) as OrgTree;
          if (!cancelled) setState({ kind: "ok", tree, at: Date.now() });
        }
      } catch (err) {
        if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
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
      poll();
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

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
    return (
      <main className="hq-shell">
        <div className="hq-banner hq-banner-attention">
          <strong>Not authorized.</strong>
          <br />
          This Telegram account isn’t on the DeloHQ operator allowlist.
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

  return <Constellation tree={state.tree} at={state.at} />;
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
        <span className="hq-node-state">{node.status}</span>
      </span>
    </button>
  );
}

function Constellation({ tree, at }: { tree: OrgTree; at: number }) {
  const [selected, setSelected] = useState<{ node: OrgNode; deptName: string } | null>(null);

  const departments = useMemo(() => [...(tree.root.children ?? [])].sort((a, b) => a.order - b.order), [tree.root.children]);
  const everyone = useMemo(() => collectAgents(tree), [tree]);
  const attention = useMemo(
    () => everyone.filter((e) => toneOf(e.node.status) === "attention" || toneOf(e.node.status) === "failed"),
    [everyone]
  );
  const working = useMemo(() => everyone.filter((e) => toneOf(e.node.status) === "working"), [everyone]);

  const totals = tree.totals ?? { agents: 0, working: 0, idle: 0, needsAttention: 0, unknown: 0 };
  const updated = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const open = (node: OrgNode, deptName: string) => setSelected({ node, deptName });

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

      {selected ? <Office entry={selected} onClose={() => setSelected(null)} /> : null}
    </main>
  );
}

function Office({ entry, onClose }: { entry: { node: OrgNode; deptName: string }; onClose: () => void }) {
  const { node, deptName } = entry;
  const tone = toneOf(node.status);
  const work = node.live?.activeWork;
  const summary = work?.summary || work?.reason || "";
  const bot = node.agentRef?.botUsername;
  const expertise = node.metadata?.expertise ?? [];

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

        <button type="button" className="hq-dm" disabled={!bot} onClick={() => openDm(bot)}>
          {bot ? "Open DM →" : "No bot linked"}
        </button>
      </div>
    </div>
  );
}

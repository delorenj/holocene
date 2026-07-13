"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EmployeeStatus, OrgNode, OrgTree } from "@holocene/org-model";

type Tone = "busy" | "idle" | "attention" | "unknown";

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
};

const POLL_MS = 5000;
const SDK_SRC = "https://telegram.org/js/telegram-web-app.js";

function toneOf(status: EmployeeStatus): Tone {
  switch (status) {
    case "working":
    case "initializing":
    case "onboarding":
      return "busy";
    case "idle":
      return "idle";
    case "blocked":
    case "failed":
      return "attention";
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
  return `${Math.round(secs / 3600)}h ago`;
}

function moodGlyph(attention: number, total: number): string {
  if (total === 0) return "•";
  if (attention === 0) return "☀";
  if (attention / total < 0.2) return "⛅";
  return "⛈";
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
          Create the <strong>@DeloHQBot</strong> in BotFather and set{" "}
          <code>TELEGRAM_HQ_BOT_TOKEN</code> on the Holocene web service, then reopen.
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
          DeloHQ is a Telegram Mini App — launch it from the <strong>@DeloHQBot</strong> menu button so it
          can prove who you are. (The page loads fine here, but the fleet data stays locked without a valid
          Telegram session.)
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

  return <Floor tree={state.tree} at={state.at} />;
}

function AgentCard({ node }: { node: OrgNode }) {
  const tone = toneOf(node.status);
  const summary = node.live?.activeWork?.summary || node.live?.activeWork?.reason || "";
  const issueId = node.live?.activeWork?.issueId;
  const age = ageLabel(node);
  const isManager = node.employeeRole === "manager";
  return (
    <article className={`hq-node hq-node-${tone}${isManager ? " hq-node-manager" : ""}`}>
      <div className="hq-node-head">
        <span className={`hq-dot hq-dot-${tone}`} />
        <span className="hq-node-name">{node.displayName || node.id}</span>
        {isManager ? <span className="hq-node-badge">lead</span> : null}
        <span className="hq-node-state">{node.status}</span>
      </div>
      <div className="hq-node-repo">
        {node.agentRef?.repo || node.id}
        {node.agentRef?.planeIdentifier ? ` · ${node.agentRef.planeIdentifier}` : ""}
      </div>
      {summary ? <div className="hq-node-task">{summary}</div> : null}
      {issueId || age ? (
        <div className="hq-node-meta">
          {issueId ? `${issueId} · ` : ""}
          {age || "no heartbeat yet"}
        </div>
      ) : null}
    </article>
  );
}

function Floor({ tree, at }: { tree: OrgTree; at: number }) {
  const root = tree.root;
  const departments = useMemo(
    () => [...(root.children ?? [])].sort((a, b) => a.order - b.order),
    [root.children]
  );

  const totals = tree.totals ?? { agents: 0, working: 0, needsAttention: 0 };
  const idle = Math.max(0, totals.agents - totals.working - totals.needsAttention);
  const updated = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <main className="hq-shell">
      <header className="hq-top">
        <div>
          <p className="hq-eyebrow">{tree.company?.name || "Company"}</p>
          <h1>The Org</h1>
          <p className="hq-ceo">
            {root.displayName} · <span>{root.title}</span>
          </p>
        </div>
        <span className="hq-mood" title="Company mood">
          {moodGlyph(totals.needsAttention, totals.agents)}
        </span>
      </header>

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
          <span>Idle</span>
          <strong>{idle}</strong>
        </div>
      </section>

      {tree.unmapped?.length ? (
        <div className="hq-banner hq-banner-attention hq-unmapped">
          {tree.unmapped.length} unmapped agent{tree.unmapped.length === 1 ? "" : "s"} in Unassigned — add{" "}
          {tree.unmapped.length === 1 ? "it" : "them"} to <code>~/.hermes/org.yaml</code>.
        </div>
      ) : null}

      {departments.map((dept) => {
        const roll = dept.rollup ?? { agents: 0, working: 0, needsAttention: 0 };
        return (
          <section key={dept.id} className="hq-dept">
            <div className="hq-dept-head">
              <span className="hq-dept-name">{dept.displayName}</span>
              <span className="hq-dept-roll">
                {roll.agents} · {roll.working} working
                {roll.needsAttention ? ` · ${roll.needsAttention} needs attn` : ""}
              </span>
            </div>
            <div className="hq-grid">
              {(dept.children ?? []).map((agent) => (
                <AgentCard key={agent.id} node={agent} />
              ))}
            </div>
          </section>
        );
      })}

      <p className="hq-foot">
        {totals.agents} agents · {departments.length} departments · updated {updated} · refreshes every 5s
      </p>
    </main>
  );
}

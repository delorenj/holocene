"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type BusyState = "idle" | "busy" | "blocked" | "stalled" | "error" | "unknown";

type ActiveWork = {
  status?: string;
  issue_id?: string;
  summary?: string;
  reason?: string;
  last_heartbeat_at?: string;
  age_seconds?: number;
};

type FleetAgent = {
  agent_id: string;
  display_name: string;
  repo: string;
  role: string;
  project_path: string;
  busy_state: BusyState;
  active_work: ActiveWork;
};

type Snapshot = {
  generatedAt: string;
  source: string;
  agents: FleetAgent[];
};

type Tone = "busy" | "idle" | "attention" | "unknown";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; snapshot: Snapshot; at: number }
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

function toneOf(state: BusyState): Tone {
  if (state === "busy") return "busy";
  if (state === "idle") return "idle";
  if (state === "blocked" || state === "stalled" || state === "error") return "attention";
  return "unknown";
}

const TONE_RANK: Record<Tone, number> = { attention: 0, busy: 1, idle: 2, unknown: 3 };

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

function ageLabel(agent: FleetAgent): string {
  const secs = agent.active_work?.age_seconds;
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
        const res = await fetch("/hq/api/snapshot", {
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
          const snapshot = (await res.json()) as Snapshot;
          if (!cancelled) setState({ kind: "ok", snapshot, at: Date.now() });
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

  return <Floor snapshot={state.snapshot} at={state.at} />;
}

function Floor({ snapshot, at }: { snapshot: Snapshot; at: number }) {
  const agents = snapshot.agents ?? [];

  const sorted = useMemo(() => {
    return [...agents].sort((a, b) => {
      const rank = TONE_RANK[toneOf(a.busy_state)] - TONE_RANK[toneOf(b.busy_state)];
      if (rank !== 0) return rank;
      return (a.display_name || a.agent_id).localeCompare(b.display_name || b.agent_id);
    });
  }, [agents]);

  const counts = useMemo(() => {
    let working = 0;
    let attention = 0;
    let idle = 0;
    for (const a of agents) {
      const tone = toneOf(a.busy_state);
      if (tone === "busy") working += 1;
      else if (tone === "attention") attention += 1;
      else if (tone === "idle") idle += 1;
    }
    return { total: agents.length, working, attention, idle };
  }, [agents]);

  const updated = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <main className="hq-shell">
      <header className="hq-top">
        <div>
          <p className="hq-eyebrow">33GOD Co.</p>
          <h1>The Floor</h1>
        </div>
        <span className="hq-mood" title="Company mood">
          {moodGlyph(counts.attention, counts.total)}
        </span>
      </header>

      <section className="hq-metrics">
        <div className="hq-metric">
          <span>Agents</span>
          <strong>{counts.total}</strong>
        </div>
        <div className="hq-metric hq-metric-working">
          <span>Working</span>
          <strong>{counts.working}</strong>
        </div>
        <div className="hq-metric hq-metric-attention">
          <span>Needs attn</span>
          <strong>{counts.attention}</strong>
        </div>
        <div className="hq-metric">
          <span>Idle</span>
          <strong>{counts.idle}</strong>
        </div>
      </section>

      <p className="hq-section-label">Everyone · needs-attention first</p>
      <section className="hq-grid">
        {sorted.map((agent) => {
          const tone = toneOf(agent.busy_state);
          const summary = agent.active_work?.summary || agent.active_work?.reason || "";
          const age = ageLabel(agent);
          return (
            <article key={agent.agent_id} className={`hq-node hq-node-${tone}`}>
              <div className="hq-node-head">
                <span className={`hq-dot hq-dot-${tone}`} />
                <span className="hq-node-name">{agent.display_name || agent.agent_id}</span>
                <span className="hq-node-state">{agent.busy_state}</span>
              </div>
              <div className="hq-node-repo">{agent.repo}</div>
              {summary ? <div className="hq-node-task">{summary}</div> : null}
              {agent.active_work?.issue_id || age ? (
                <div className="hq-node-meta">
                  {agent.active_work?.issue_id ? `${agent.active_work.issue_id} · ` : ""}
                  {age || "no heartbeat yet"}
                </div>
              ) : null}
            </article>
          );
        })}
      </section>

      <p className="hq-foot">
        {counts.total} agents · updated {updated} · refreshes every 5s
      </p>
    </main>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { AgentsView } from "./agents-view";
import { ProjectsView } from "./projects-view";
import { SourceStrip } from "./ui";
import type { AgentsPayload, ProjectsPayload } from "./types";

// The hub shell: one SPA, two views over the same agent→project join. View and
// focus live in the URL so a link to "bloodbank's PM" or "the pjangler project"
// survives a reload; the theme lives in localStorage.

type View = "agents" | "projects";
type Theme = "ledger" | "ledger-night";

const POLL_MS = 5000;
const THEME_KEY = "holocene.hub.theme";

function readUrl(): { view: View; focus?: string } {
  const q = new URLSearchParams(window.location.search);
  return { view: q.get("view") === "projects" ? "projects" : "agents", focus: q.get("focus") ?? undefined };
}

function writeUrl(view: View, focus: string | undefined, push: boolean) {
  const q = new URLSearchParams(window.location.search);
  q.set("view", view);
  if (focus) q.set("focus", focus);
  else q.delete("focus");
  const url = `${window.location.pathname}?${q.toString()}`;
  if (push) window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

function usePoll<T>(url: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = (await res.json()) as T;
        if (live) (setData(body), setError(undefined));
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (live) timer = setTimeout(tick, document.hidden ? POLL_MS * 4 : POLL_MS);
      }
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [url]);
  return { data, error };
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("ledger");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      if (stored === "ledger" || stored === "ledger-night") setTheme(stored);
    } catch {
      // storage blocked: default theme
    }
  }, []);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === "ledger" ? "ledger-night" : "ledger";
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {
        // storage blocked: the toggle still applies to this visit
      }
      return next;
    });
  }, []);
  useEffect(() => {
    document.documentElement.dataset.hubTheme = theme;
  }, [theme]);
  return [theme, toggle];
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function agentsStatement(d: AgentsPayload): string {
  const waiting = d.agents.filter((a) => a.signal === "you");
  const broken = d.agents.filter((a) => a.signal === "broken" || a.signal === "stuck");
  const working = d.agents.filter((a) => a.active && a.signal !== "you" && a.signal !== "broken" && a.signal !== "stuck");
  const parts: string[] = [];
  if (waiting.length === 1) parts.push(`${waiting[0].name} is waiting on you.`);
  else if (waiting.length) parts.push(`${waiting.length} agents are waiting on you.`);
  if (broken.length) parts.push(`${plural(broken.length, "agent")} ${broken.length === 1 ? "is" : "are"} failing or stale.`);
  if (working.length) {
    const lead = waiting.length || broken.length ? `${plural(working.length, "other agent")}` : plural(working.length, "agent");
    parts.push(`${lead} ${working.length === 1 ? "is" : "are"} active${d.contractors.length ? `, with ${plural(d.contractors.length, "contractor")} out` : ""}.`);
  } else if (!waiting.length && !broken.length) parts.push(d.agents.length ? "No agent is active right now." : "No agents in the registry.");
  if (d.stats.noProject) parts.push(`${d.stats.noProject} of ${d.agents.length} agents have no project record.`);
  return parts.join(" ");
}

function projectsStatement(d: ProjectsPayload): string {
  const parent = d.projects.find((p) => p.kind === "parent");
  const children = d.projects.filter((p) => p.kind === "component" && p.registered);
  const withPm = children.filter((p) => p.pm);
  const unindexed = d.projects.filter((p) => p.kind === "component" && p.pm && !p.indexed);
  const islands = d.projects.filter((p) => p.kind === "island");
  const parts: string[] = [];
  if (parent && children.length) parts.push(`${withPm.length} of ${parent.name}’s ${plural(children.length, "registered child project")} ${withPm.length === 1 ? "has" : "have"} a project manager.`);
  if (unindexed.length) parts.push(`${unindexed.map((p) => p.name).join(", ")} ${unindexed.length === 1 ? "is" : "are"} not indexed by pjangler yet.`);
  if (islands.length) parts.push(`${plural(islands.length, "standalone project")}, ${islands.filter((p) => p.pm).length} with a PM.`);
  return parts.join(" ") || "No projects found in pjangler.";
}

function Brand() {
  return (
    <a className="hub-brand" href="/" aria-label="33GOD Holocene">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M11 1.5A5.25 5.25 0 0 0 11 12ZM11 12a5.25 5.25 0 0 0 0 10.5ZM13 1.5A5.25 5.25 0 0 1 13 12Z" className="brand-ink" />
        <path d="M13 12a5.25 5.25 0 0 1 0 10.5Z" className="brand-pop" />
      </svg>
      <span className="brand-word">33GOD</span>
      <span className="brand-app">Holocene</span>
    </a>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const night = theme === "ledger-night";
  return (
    <button type="button" className="hub-theme" aria-pressed={night} onClick={onToggle} title={night ? "Switch to Ledger (day)" : "Switch to Ledger night (provisional)"}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        {night ? (
          <path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1Z" fill="currentColor" />
        ) : (
          <>
            <circle cx="8" cy="8" r="3" fill="currentColor" />
            <path d="M8 .8v2M8 13.2v2M.8 8h2M13.2 8h2M2.9 2.9l1.4 1.4M11.7 11.7l1.4 1.4M2.9 13.1l1.4-1.4M11.7 4.3l1.4-1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
          </>
        )}
      </svg>
      <span>{night ? "Night" : "Day"}</span>
    </button>
  );
}

export function HubApp() {
  const [view, setView] = useState<View>("agents");
  const [focus, setFocus] = useState<string>();
  const [theme, toggleTheme] = useTheme();
  const [now, setNow] = useState(() => Date.now());
  const agents = usePoll<AgentsPayload>("/api/modules/hub/agents");
  const projects = usePoll<ProjectsPayload>("/api/modules/hub/projects");

  useEffect(() => {
    const sync = () => {
      const u = readUrl();
      setView(u.view);
      setFocus(u.focus);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const go = useCallback((next: View, nextFocus?: string) => {
    setView(next);
    setFocus(nextFocus);
    writeUrl(next, nextFocus, true);
  }, []);
  const focusIn = useCallback(
    (id: string) => {
      setFocus(id);
      writeUrl(view, id, false);
    },
    [view]
  );

  const current = view === "agents" ? agents : projects;
  const sources = current.data?.sources ?? [];
  const statement = view === "agents" ? (agents.data ? agentsStatement(agents.data) : undefined) : projects.data ? projectsStatement(projects.data) : undefined;

  return (
    <div className="hub-root" data-theme={theme}>
      <header className="hub-header">
        <Brand />
        <nav className="hub-tabs" aria-label="Views">
          <button type="button" className="hub-tab" aria-current={view === "agents" ? "page" : undefined} onClick={() => go("agents")}>Agents</button>
          <button type="button" className="hub-tab" aria-current={view === "projects" ? "page" : undefined} onClick={() => go("projects")}>Projects</button>
        </nav>
        <div className="hub-header-end">
          <SourceStrip sources={sources} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="hub-body">
        <div className="hub-lede">
          <p className="hub-statement" aria-live="polite">{statement ?? (current.error ? "The hub API is not answering." : "Reading the fleet…")}</p>
          {current.error ? (
            <p className="hub-error" role="status">
              <span className="hub-label">API</span>
              {current.data ? `Showing the last good read. ${current.error}` : current.error}
            </p>
          ) : null}
        </div>

        {view === "agents" ? (
          agents.data ? (
            <AgentsView data={agents.data} now={now} focus={focus} onFocus={focusIn} onOpenProject={(id) => go("projects", id)} />
          ) : (
            <Placeholder error={agents.error} />
          )
        ) : projects.data ? (
          <ProjectsView data={projects.data} now={now} focus={focus} onFocus={focusIn} onOpenAgent={(id) => go("agents", id)} />
        ) : (
          <Placeholder error={projects.error} />
        )}

        <footer className="hub-foot">
          <span>Holocene reads Bloodbank; it never publishes.</span>
          <a href="/legacy">Legacy dashboard</a>
          <a href="/hooks">Hooks</a>
        </footer>
      </div>
    </div>
  );
}

function Placeholder({ error }: { error?: string }) {
  return (
    <div className="hub-placeholder">
      <span className="hub-label">{error ? "No data" : "Loading"}</span>
      <p>{error ? `GET /api/modules/hub failed: ${error}` : "Joining the agents registry, ASM and pjangler…"}</p>
    </div>
  );
}

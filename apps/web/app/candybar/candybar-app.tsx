"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Brand, ThemeToggle, usePoll, useTheme } from "../hub/hub-app";
import { CopyRef, Glyph, HubTabs, SourceStrip, formatDuration, sinceSeconds } from "../hub/ui";
import type { Signal, Source } from "../hub/types";
import { ActionBar, Announcer } from "./action-bar";
import { actionStore } from "./action-store";
import { groupByProject, homeView, projectOf, rowDescription, rowName, splitViews, staleNote, type Group } from "./candybar-model";
import { endOnInteraction } from "./focus-intent";
import { NOISE_MINUTES, describeCron, isFrequent } from "./cron";
import { ProfileView, TasksView } from "./profile-panel";
import { OutcomeChip, RunStrip, TaskChip, activeTask } from "./row-parts";
import { ScheduleView } from "./schedule-view";
import type { CandybarPayload, CandybarRow, LastRun, TabId, ViewId } from "./types";

// The Candybar tab. Schedule (the default) is today's fires, live; Definitions is every
// recurring job Candybar (the host's single clock) knows, active and inactive, with when it
// fires next, how its last 30 runs went, and what the steward has written about it. Each row's
// panel carries the actions (enrich, evaluate, fix, mark noise, disable, archive); Holocene
// asks Candybar and never registers, edits or runs a candybar itself.
// Next fires come from Candybar's own /schedule, so DST and skips match the dispatcher.
// State (tab, view, group, sort, search, noise, open row) lives in the URL.

const POLL_MS = 15_000;

const VIEWS: Array<{ id: ViewId; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "inactive", label: "Inactive" },
  { id: "failing", label: "Failing" },
  { id: "archived", label: "Archived" }
];

type Sort = "next" | "name";
type Group_ = "none" | "project";
type UrlState = { tab: TabId; view: ViewId; sort: Sort; group: Group_; q: string; noise: boolean; showNoise: boolean; open?: string };
const DEFAULT_STATE: UrlState = { tab: "schedule", view: "all", sort: "next", group: "none", q: "", noise: false, showNoise: false };
const TABS: Array<{ id: TabId; label: string }> = [
  { id: "schedule", label: "Schedule" },
  { id: "definitions", label: "Definitions" }
];

// ---------- URL state ----------

function readUrl(): UrlState {
  const q = new URLSearchParams(window.location.search);
  const view = q.get("view");
  // Links from before the Schedule tab carry Definitions' own params, so they still open Definitions.
  const legacy = ["view", "sort", "group", "noise", "open"].some((k) => q.has(k));
  return {
    tab: q.get("tab") === "definitions" || (!q.has("tab") && legacy) ? "definitions" : "schedule",
    showNoise: q.get("fires") === "all",
    view: VIEWS.some((v) => v.id === view) ? (view as ViewId) : "all",
    sort: q.get("sort") === "name" ? "name" : "next",
    group: q.get("group") === "project" ? "project" : "none",
    q: q.get("q") ?? "",
    noise: q.get("noise") === "1",
    open: q.get("open") || undefined
  };
}

function writeUrl(s: UrlState) {
  const q = new URLSearchParams();
  if (s.tab !== "schedule") q.set("tab", s.tab);
  if (s.showNoise) q.set("fires", "all");
  if (s.q) q.set("q", s.q);
  // Definitions' own params would read as a legacy Definitions link on reload, so Schedule drops them from the URL
  // (they stay in memory for the way back).
  if (s.tab === "definitions") writeDefinitionParams(q, s);
  const qs = q.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
}

function writeDefinitionParams(q: URLSearchParams, s: UrlState) {
  if (s.view !== "all") q.set("view", s.view);
  if (s.sort !== "next") q.set("sort", s.sort);
  if (s.group !== "none") q.set("group", s.group);
  if (s.noise) q.set("noise", "1");
  if (s.open) q.set("open", s.open);
}

const isNoise = (c: CandybarRow) => c.noise || isFrequent(c.schedule);

// ---------- formatting ----------
// Wall-clock times are shown in the candybar's own zone (the zone its cron reads in), labelled, so "daily 04:15" and
// the next fire's "4:15 AM EST" always agree whatever zone the browser is in.

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoned(kind: "clock" | "dayClock" | "stamp", zone: string): Intl.DateTimeFormat {
  const key = `${kind} ${zone}`;
  let f = formatters.get(key);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions =
      kind === "clock" ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" }
        : kind === "dayClock" ? { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }
          : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
    try {
      f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: zone });
    } catch {
      f = new Intl.DateTimeFormat("en-US", opts); // an unknown zone name: the browser's zone, still labelled
    }
    formatters.set(key, f);
  }
  return f;
}
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ms = (iso?: string | null) => (iso ? Date.parse(iso) : NaN);
const valid = (iso?: string | null): iso is string => Number.isFinite(ms(iso));

function zonedTime(iso: string, zone: string, now: number): string {
  const day = (t: number) => zoned("stamp", zone).formatToParts(t).filter((p) => p.type === "month" || p.type === "day").map((p) => p.value).join(" ");
  return zoned(day(ms(iso)) === day(now) ? "clock" : "dayClock", zone).format(ms(iso));
}
const stampIn = (iso: string | undefined, zone: string) => (valid(iso) ? zoned("stamp", zone).format(ms(iso)) : "—");

function countdown(iso: string, now: number): string {
  const s = (ms(iso) - now) / 1000;
  if (s <= 0) return "due now";
  return `in ${formatDuration(s)}`;
}

function lastRunSignal(run: LastRun | null | undefined): Signal {
  if (run === undefined) return "unknown";
  if (run === null) return "quiet";
  return run.result === "success" ? "cleared" : run.result === "fail" ? "broken" : "working";
}

function rowSignal(c: CandybarRow): Signal {
  if (!c.enabled) return "quiet";
  if (c.lastRun?.result === "fail") return "broken";
  if (c.lastRun?.result === "running") return "working";
  return c.lastRun ? "cleared" : "unknown";
}

function statement(d: CandybarPayload): string {
  if (d.source.down && !d.candybars.length) return "Candybar is not answering, and nothing has been read from it yet.";
  const c = d.counts;
  const lead = d.source.down ? "Candybar is not answering. From the last good read: " : "";
  const failing = c.failing ? ` ${c.failing} of the active ones failed on their last run.` : " None of the active ones failed on its last run.";
  const archived = c.archived ? ` ${c.archived} archived.` : "";
  return `${lead}${plural(c.total, "candybar")}: ${c.active} active, ${c.inactive} inactive.${failing}${archived}`;
}

// ---------- small parts ----------

function Chips({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <span className="cb-chips">
      {items.map((x, i) => <span key={`${i}-${x}`} className="cb-chip">{x}</span>)}
    </span>
  );
}

function StateBadge({ c }: { c: CandybarRow }) {
  if (c.archived) return <span className="cb-state is-archived">Archived</span>;
  return c.enabled ? <span className="cb-state is-active">Active</span> : <span className="cb-state is-inactive">Inactive</span>;
}

function NextFire({ c, now, windowKnown }: { c: CandybarRow; now: number; windowKnown: boolean }) {
  if (!c.enabled) return <span className="cb-next is-none">not scheduled</span>;
  if (!windowKnown) return <span className="cb-next is-none" title="Candybar's schedule could not be read">—</span>;
  if (!c.nextFire) return <span className="cb-next is-none" title="no fire in the next 24 hours">after 24h</span>;
  return (
    <span className="cb-next">
      <time className="cb-next-in" dateTime={c.nextFire}>{countdown(c.nextFire, now)}</time>
      <span className="cb-next-at">{zonedTime(c.nextFire, c.timezone, now)}</span>
    </span>
  );
}

function LastRunCell({ run, now }: { run: LastRun | null | undefined; now: number }) {
  if (run === undefined) return <span className="cb-run is-unknown"><Glyph signal="unknown" /> unread</span>;
  if (run === null) return <span className="cb-run is-never"><Glyph signal="quiet" /> never run</span>;
  const age = sinceSeconds(run.finishedAt ?? run.startedAt, now);
  const word = run.result === "success" ? "passed" : run.result === "fail" ? "failed" : "running";
  return (
    <span className={`cb-run is-${run.result}`} title={run.errorMessage}>
      <Glyph signal={lastRunSignal(run)} />
      <span className="cb-run-word">{word}</span>
      {age !== undefined ? <span className="cb-run-age">{run.result === "running" ? `for ${formatDuration(age)}` : `${formatDuration(age)} ago`}</span> : null}
    </span>
  );
}

// ---------- rows ----------

function Panel({ c, now, id, onChanged, stale }: { c: CandybarRow; now: number; id: string; onChanged: () => void; stale?: string }) {
  const run = c.lastRun;
  const dd: Array<[string, React.ReactNode]> = [
    ["Schedule", <><code>{c.schedule}</code>{describeCron(c.schedule) ? ` · ${describeCron(c.schedule)}` : ""}</>],
    ["Timezone", c.timezone],
    ["State", c.archived ? "Archived — disabled and hidden from the lists and the schedule" : c.enabled ? "Active — dispatched on schedule" : "Inactive — registered, never fires"],
    ...(projectOf(c) ? [["Project", `${projectOf(c)}${c.profile?.project ? ` (${c.profile.project.method})` : ""}`] as [string, React.ReactNode]] : []),
    ["Next fire", c.enabled && c.nextFire ? `${stampIn(c.nextFire, c.timezone)} (${countdown(c.nextFire, now)})` : c.enabled ? "not within 24h" : "—"],
    ["Noise", c.noise ? "in the noise collection" : isFrequent(c.schedule) ? "fires more often than every 10 min" : "no"],
    ["Registered", valid(c.createdAt) ? DATE.format(ms(c.createdAt)) : "—"]
  ];
  if (run) {
    dd.push(
      ["Last run", `${stampIn(run.startedAt, c.timezone)}${run.trigger && run.trigger !== "scheduled" ? ` · ${run.trigger}` : ""}`],
      ["Runtime", run.runtimeMs !== undefined ? (run.runtimeMs < 1000 ? `${run.runtimeMs} ms` : formatDuration(run.runtimeMs / 1000)) : run.result === "running" ? "still running" : "—"]
    );
  }
  return (
    <div className="cb-panel" id={id}>
      {c.description ? <p className="cb-full-desc">{c.description}</p> : null}
      {run?.result === "fail" && run.errorMessage ? (
        <p className="cb-error"><span className="hub-label">Last failure</span>{run.errorMessage}</p>
      ) : null}
      <ActionBar c={c} now={now} onChanged={onChanged} stale={stale} />
      <ProfileView profile={c.profile} tasks={c.tasks} />
      <TasksView tasks={c.tasks} />
      <dl className="cb-dl">
        {dd.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
        {c.tags.length ? <div><dt>Tags</dt><dd><Chips items={c.tags} /></dd></div> : null}
      </dl>
      <div className="cb-refs">
        <CopyRef value={`candybar show ${c.name}`} />
        <CopyRef value={`candybar history ${c.name} -n 10`} />
        <CopyRef value={c.id} label={`id ${c.id.slice(0, 13)}`} />
      </div>
    </div>
  );
}

function Row({ c, now, windowKnown, open, onToggle, onChanged, showProject = true, stale }: {
  c: CandybarRow;
  now: number;
  windowKnown: boolean;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  /** False when the rows sit under a project heading, which already says it. */
  showProject?: boolean;
  /** Set when the profiles or steward tasks come from an earlier read: how old, in words. */
  stale?: string;
}) {
  const panelId = `cb-panel-${c.id}`;
  const descId = `cb-row-desc-${c.id}`;
  const words = describeCron(c.schedule);
  const task = activeTask(c);
  const project = projectOf(c);
  const outcome = c.profile?.evaluation?.outcome;
  return (
    <article className={`cb-row${c.enabled ? "" : " is-inactive"}${c.archived ? " is-archived" : ""}${open ? " is-open" : ""}`} data-candybar-id={c.id}>
      {/* The button's name stays short (name, state, next fire); the rest of what the row shows is its description. */}
      <button
        type="button"
        className="cb-row-head"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={rowName(c, now, windowKnown)}
        aria-describedby={descId}
        onClick={onToggle}
      >
        <span className="cb-sig"><Glyph signal={rowSignal(c)} size={12} /></span>
        <span className="cb-main">
          <span className="cb-name-line">
            <span className="cb-name">{c.name}</span>
            {!c.enabled || c.archived ? <StateBadge c={c} /> : null}
            {c.noise ? <span className="cb-flag">noise</span> : null}
            {project && showProject ? <span className="cb-project" title={`Project: ${project}`}>{project}</span> : null}
            {outcome ? <OutcomeChip outcome={outcome} /> : null}
            {task ? <TaskChip task={task} now={now} /> : null}
          </span>
          {c.description ? <span className="cb-desc">{c.description}</span> : null}
          <span className="cb-meta">
            <span className="cb-cron"><code>{c.schedule}</code>{words ? <span className="cb-cron-words">{words}</span> : null}</span>
            <span className="cb-tz">{c.timezone}</span>
            <Chips items={c.tags} />
          </span>
        </span>
        <span className="cb-when"><NextFire c={c} now={now} windowKnown={windowKnown} /></span>
        <span className="cb-last">
          <LastRunCell run={c.lastRun} now={now} />
          <RunStrip history={c.history} />
        </span>
      </button>
      <span id={descId} hidden>{rowDescription(c, now)}</span>
      {open ? <Panel c={c} now={now} id={panelId} onChanged={onChanged} stale={stale} /> : null}
    </article>
  );
}

function Columns() {
  return (
    <div className="cb-columns" aria-hidden="true">
      <span />
      <span>Candybar · schedule</span>
      <span>Next fire</span>
      <span>Last run</span>
    </div>
  );
}

function Section({ title, count, children, note }: { title: string; count: number; children: React.ReactNode; note?: string }) {
  return (
    <section className="cb-section" aria-label={`${title}, ${count}`}>
      <h2 className="cb-heading">
        {title}
        <span className="cb-heading-count">{count}</span>
        {note ? <span className="cb-heading-note">{note}</span> : null}
      </h2>
      <Columns />
      <div className="cb-list">{children}</div>
    </section>
  );
}

// ---------- the app ----------

const byName = (a: CandybarRow, b: CandybarRow) => a.name.localeCompare(b.name);
function byNext(a: CandybarRow, b: CandybarRow) {
  const x = ms(a.nextFire);
  const y = ms(b.nextFire);
  if (Number.isNaN(x) !== Number.isNaN(y)) return Number.isNaN(x) ? 1 : -1;
  return (Number.isNaN(x) ? 0 : x - y) || byName(a, b);
}

export function CandybarApp() {
  const [theme, toggleTheme] = useTheme();
  const [state, setState] = useState<UrlState>(DEFAULT_STATE);
  const [searchText, setSearchText] = useState("");
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    const sync = () => {
      const u = readUrl();
      setState(u);
      setSearchText(u.q);
      setReady(true);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  // Countdowns tick locally from fireTime; the list itself refreshes on the 15 s poll.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const update = useCallback((patch: Partial<UrlState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      writeUrl(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    const q = searchText.trim();
    const t = setTimeout(() => update({ q }), 150);
    return () => clearTimeout(t);
  }, [searchText, ready, update]);

  const list = usePoll<CandybarPayload>("/api/modules/candybar/list", POLL_MS);
  const reload = list.reload;
  const data = list.data;

  // Tasks this page queued are shown from the POST's answer until the list has them.
  useEffect(() => {
    if (data) actionStore.reconcile(data.candybars);
  }, [data]);

  // The operator taking over (any pointerdown or keydown) ends the intent: a poll after that must not pull focus back.
  useEffect(() => endOnInteraction(document, () => actionStore.clearFocusIntent()), []);

  // A change that moves a row (Disable sends it to Inactive, Archive out of the view) remounts it, and focus would drop
  // to the page. While an action's focus intent is live, a lost focus goes to the same button in the row's new place,
  // else the row itself, else the view tab where the row now lives.
  useEffect(() => {
    const intent = actionStore.focusIntent();
    if (!intent || !data) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const row = document.querySelector<HTMLElement>(`[data-candybar-id="${intent.candybarId}"]`);
    const target = row?.querySelector<HTMLElement>(`[data-action="${intent.key}"]`) ?? row?.querySelector<HTMLElement>(".cb-row-head");
    if (target) {
      target.focus();
      actionStore.clearFocusIntent();
      return;
    }
    const c = data.candybars.find((x) => x.id === intent.candybarId);
    if (c) {
      tabRefs.current[homeView(c)]?.focus();
      actionStore.clearFocusIntent();
    }
  }, [data, state.view, state.group]);

  // The search applies first; "Hide noise" then drops noisy candybars, except one whose last run failed: a failure
  // is never noise.
  const searched = useMemo(() => {
    const needle = state.q.toLowerCase();
    if (!needle) return data?.candybars ?? [];
    return (data?.candybars ?? []).filter((c) => [c.name, c.description, c.schedule, c.timezone, projectOf(c) ?? "", ...c.tags].some((s) => s.toLowerCase().includes(needle)));
  }, [data, state.q]);
  const hideable = (c: CandybarRow) => !c.archived && isNoise(c) && c.lastRun?.result !== "fail";
  const filtered = useMemo(() => (state.noise ? searched.filter((c) => !hideable(c)) : searched), [searched, state.noise]);
  const hiddenNoise = state.noise ? searched.length - filtered.length : 0;

  const sorter = state.sort === "name" ? byName : byNext;
  // Archived candybars belong to the Archived view alone; they are in no other list or count.
  const views = useMemo(() => splitViews(filtered), [filtered]);
  const active = useMemo(() => [...views.active].sort(sorter), [views, sorter]);
  const inactive = useMemo(() => [...views.inactive].sort(byName), [views]);
  const failing = useMemo(() => [...views.failing].sort(sorter), [views, sorter]);
  const archived = useMemo(() => [...views.archived].sort(byName), [views]);

  const counts: Record<ViewId, number> = { all: active.length + inactive.length, active: active.length, inactive: inactive.length, failing: failing.length, archived: archived.length };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = VIEWS.findIndex((t) => t.id === state.view);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % VIEWS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + VIEWS.length) % VIEWS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = VIEWS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    update({ view: VIEWS[next].id });
    tabRefs.current[VIEWS[next].id]?.focus();
  };

  const toggle = (id: string) => update({ open: state.open === id ? undefined : id });
  const windowKnown = data?.window.known ?? false;
  const stale = data ? staleNote(data.stale, data.generated_at, now) : undefined;
  const rows = (items: CandybarRow[]) =>
    items.map((c) => <Row key={c.id} c={c} now={now} windowKnown={windowKnown} open={state.open === c.id} onToggle={() => toggle(c.id)} onChanged={reload} showProject={state.group !== "project"} stale={stale} />);

  const [streamSource, setStreamSource] = useState<Source>();
  const sources: Source[] = state.tab === "schedule"
    ? (streamSource ? [streamSource] : [])
    : data
      ? [{ ...data.source, ageSeconds: (data.source.ageSeconds ?? 0) + (sinceSeconds(data.generated_at, now) ?? 0) }]
      : [];

  const empty = (what: string) => (
    <div className="hub-placeholder">
      <span className="hub-label">Empty view</span>
      <p>{state.q ? `No ${what} match “${state.q}”.` : state.noise && hiddenNoise ? `No ${what} outside the noise.` : `No ${what}.`}</p>
    </div>
  );

  let body: React.ReactNode;
  if (!data || (data.source.down && !data.candybars.length)) {
    body = (
      <div className="hub-placeholder">
        <span className="hub-label">{list.error || data ? "No data" : "Loading"}</span>
        <p>
          {list.error
            ? `GET /api/modules/candybar/list failed: ${list.error}`
            : data
              ? `Candybar did not answer: ${data.source.detail ?? "unknown error"}`
              : "Reading Candybar…"}
        </p>
      </div>
    );
  } else {
    const items = state.view === "all" ? [...active, ...inactive] : state.view === "active" ? active : state.view === "inactive" ? inactive : state.view === "failing" ? failing : archived;
    const noun = state.view === "all" ? "candybars" : state.view === "failing" ? "failing candybars" : `${state.view} candybars`;
    if (!items.length) body = empty(noun);
    else if (state.group === "project") {
      // Within a project the current sort stands; the sections themselves run A to Z with Unclassified last.
      const groups: Array<Group<CandybarRow>> = groupByProject(items);
      body = <>{groups.map((g) => <Section key={g.key} title={g.label} count={g.items.length}>{rows(g.items)}</Section>)}</>;
    } else if (state.view === "all") {
      body = (
        <>
          {active.length ? <Section title="Active" count={active.length} note={state.sort === "next" ? "soonest first" : undefined}>{rows(active)}</Section> : null}
          {inactive.length ? <Section title="Inactive" count={inactive.length} note="registered, never fire">{rows(inactive)}</Section> : null}
        </>
      );
    } else body = <><Columns /><div className="cb-list">{rows(items)}</div></>;
  }

  return (
    <div className="hub-root" data-theme={theme}>
      <header className="hub-header">
        <Brand />
        <HubTabs current="candybar" />
        <div className="hub-header-end">
          <SourceStrip sources={sources} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="hub-body">
        <Announcer />
        <nav className="cb-modes" aria-label="Candybar views">
          {TABS.map((t) => (
            <a
              key={t.id}
              href={t.id === "schedule" ? "?" : "?tab=definitions"}
              className="cb-mode"
              aria-current={state.tab === t.id ? "page" : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                update({ tab: t.id });
              }}
            >
              {t.label}
            </a>
          ))}
        </nav>

        {state.tab === "schedule" ? (
          <ScheduleView
            now={now}
            q={state.q}
            searchText={searchText}
            onSearch={setSearchText}
            showNoise={state.showNoise}
            onShowNoise={(showNoise) => update({ showNoise })}
            onSource={setStreamSource}
            onOpenDefinition={(open) => update({ tab: "definitions", open })}
          />
        ) : (
          <>
            <div className="hub-lede">
              <p className="hub-statement" aria-live="polite">
                {data ? statement(data) : list.error ? "The Holocene API is not answering." : "Reading Candybar…"}
              </p>
              {data?.source.down && data.source.detail && data.candybars.length ? (
                <p className="hub-error" role="status"><span className="hub-label">Candybar</span>{data.source.detail}</p>
              ) : null}
              {data?.warnings.map((w) => (
                <p key={w} className="hub-error" role="status"><span className="hub-label">Partial</span>{w}</p>
              ))}
              {list.error && data ? (
                <p className="hub-error" role="status"><span className="hub-label">API</span>Showing the last good read. {list.error}</p>
              ) : null}
            </div>

            <div className="cb-controls">
              <div className="cb-tabs" role="tablist" aria-label="Which candybars" onKeyDown={onTabKey}>
                {VIEWS.map((t) => (
                  <button
                    key={t.id}
                    ref={(el) => { tabRefs.current[t.id] = el; }}
                    type="button"
                    role="tab"
                    id={`cb-tab-${t.id}`}
                    aria-selected={state.view === t.id}
                    aria-controls="cb-results"
                    tabIndex={state.view === t.id ? 0 : -1}
                    className={`cb-tab${t.id === "failing" && counts.failing ? " is-alarm" : ""}`}
                    onClick={() => update({ view: t.id })}
                  >
                    {t.label}
                    {data ? <span className="cb-tab-count">{counts[t.id]}</span> : null}
                  </button>
                ))}
              </div>

              <div className="cb-controls-end">
                <div className="cb-group" role="group" aria-label="Group candybars">
                  {(["none", "project"] as const).map((g) => (
                    <button key={g} type="button" className="cb-seg" aria-pressed={state.group === g} onClick={() => update({ group: g })}>
                      {g === "none" ? "Ungrouped" : "By project"}
                    </button>
                  ))}
                </div>
                {state.view !== "inactive" && state.view !== "archived" ? (
                  <div className="cb-group" role="group" aria-label="Sort active candybars">
                    {(["next", "name"] as const).map((s) => (
                      <button key={s} type="button" className="cb-seg" aria-pressed={state.sort === s} onClick={() => update({ sort: s })}>
                        {s === "next" ? "Next fire" : "Name"}
                      </button>
                    ))}
                  </div>
                ) : null}
                <input
                  type="search"
                  className="cb-search"
                  placeholder="Filter by name, tag, cron"
                  aria-label="Filter candybars"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                />
                <label className="cb-check">
                  <input type="checkbox" checked={state.noise} onChange={(e) => update({ noise: e.target.checked })} />
                  Hide noise
                  {state.noise && hiddenNoise ? <span className="cb-check-count">{hiddenNoise} hidden</span> : null}
                </label>
              </div>
            </div>

            <div id="cb-results" role="tabpanel" aria-labelledby={`cb-tab-${state.view}`} className="cb-results">
              {body}
            </div>
          </>
        )}

        <footer className="hub-foot">
          <span>
            Candybar is the single clock. These buttons ask it to skip, enable, disable, archive or mark noise, and queue its steward to enrich, evaluate or fix; changing a schedule or a runner stays with <code>candybar edit</code>.
            {state.tab === "definitions" ? ` Noise is the explicit collection plus anything firing more often than every ${NOISE_MINUTES} min.` : null}
          </span>
        </footer>
      </div>
    </div>
  );
}

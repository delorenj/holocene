"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Brand, ThemeToggle, usePoll, useTheme } from "../hub/hub-app";
import { CopyRef, HubTabs, SourceStrip, formatDuration, sinceSeconds } from "../hub/ui";
import type { Source } from "../hub/types";
import type {
  KindView,
  SearchHit,
  TranscriptDetailPayload,
  TranscriptRow,
  TranscriptSearchPayload,
  TranscriptTicket,
  TranscriptsPayload,
  ViewId
} from "./types";

// The Transcripts tab: every recording by kind (monologue, meeting, phone call, other)
// and by project, with the tickets `px harvest` filed from it. Read-only by design:
// Holocene runs nothing here. The listing is fetched once for all kinds, so switching
// the kind or the grouping is instant and client-side; the expanded panel fetches the
// one transcript's tickets. State (kind, grouping, search, open row) lives in the URL.

const POLL_MS = 15_000;
const SEARCH_DEBOUNCE_MS = 300;

const KIND_LABEL: Record<KindView, string> = {
  monolog: "Monologues", meeting: "Meetings", phone_call: "Phone calls", other: "Other", unsorted: "Unsorted"
};
const KIND_NOUN: Record<KindView, [string, string]> = {
  monolog: ["monologue", "monologues"], meeting: ["meeting", "meetings"], phone_call: ["phone call", "phone calls"],
  other: ["other", "other"], unsorted: ["unsorted", "unsorted"]
};
const KIND_ORDER: KindView[] = ["monolog", "meeting", "phone_call", "other", "unsorted"];

type Group = "list" | "project";
type UrlState = { view: ViewId; group: Group; q: string; hermes: boolean; open?: number };

// ---------- URL state ----------

function readUrl(): UrlState {
  const q = new URLSearchParams(window.location.search);
  const rawView = q.get("view");
  const group: Group = q.get("group") === "project" ? "project" : "list";
  const view: ViewId = rawView === "all" || (KIND_ORDER as string[]).includes(rawView ?? "") ? (rawView as ViewId) : "monolog";
  const open = Number(q.get("open"));
  return {
    view: view === "all" && group === "list" ? "monolog" : view,
    group,
    q: q.get("q") ?? "",
    hermes: q.get("hermes") === "1",
    open: Number.isSafeInteger(open) && open > 0 ? open : undefined
  };
}

function writeUrl(s: UrlState) {
  const q = new URLSearchParams();
  if (s.view !== "monolog") q.set("view", s.view);
  if (s.group !== "list") q.set("group", s.group);
  if (s.q) q.set("q", s.q);
  if (s.hermes) q.set("hermes", "1");
  if (s.open) q.set("open", String(s.open));
  const qs = q.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
}

// ---------- formatting ----------

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

function dayLabel(iso: string | null): string {
  const t = iso ? new Date(iso) : undefined;
  if (!t || Number.isNaN(t.getTime())) return "Undated";
  return t.getFullYear() === new Date().getFullYear() ? MONTH.format(t) : MONTH_YEAR.format(t);
}
function clock(iso: string | null): string {
  const t = iso ? new Date(iso) : undefined;
  return t && !Number.isNaN(t.getTime()) ? CLOCK.format(t).toLowerCase() : "";
}
function when(iso: string | null): string {
  return iso ? `${dayLabel(iso)} · ${clock(iso)}` : "Undated";
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const wpm = (r: TranscriptRow) => (r.word_count && r.duration_s && r.duration_s >= 10 ? Math.round(r.word_count / (r.duration_s / 60)) : undefined);
const kindOf = (r: TranscriptRow): KindView => r.classification ?? "unsorted";
const harvested = (r: TranscriptRow) => r.harvest.run_count > 0;
const byNewest = (a: TranscriptRow, b: TranscriptRow) => (b.effective_at ?? "").localeCompare(a.effective_at ?? "");

function statement(d: TranscriptsPayload): string {
  if (d.source.down) return `The Wax transcript store is not answering — showing ${d.rows.length ? "the last good read" : "no recordings"}.`;
  const c = d.counts;
  const parts = (["monolog", "meeting", "phone_call", "other"] as const).map((k) => `${c[k] ?? 0} ${KIND_NOUN[k][(c[k] ?? 0) === 1 ? 0 : 1]}`);
  const done = d.rows.filter(harvested).length;
  return `${parts.join(", ")}. ${done} of ${d.rows.length} loaded recordings ${done === 1 ? "has" : "have"} been harvested.`;
}

// ---------- small parts ----------

function Marked({ text }: { text: string }) {
  // Wax marks the matched words with « » in a lexical snippet.
  const parts = text.split(/(«[^»]*»)/u);
  return (
    <>
      {parts.map((p, i) => (p.startsWith("«") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}

function HarvestBadge({ row }: { row: TranscriptRow }) {
  const h = row.harvest;
  if (h.state === "harvested") return <span className="tr-badge is-harvested">{plural(h.ticket_count, "ticket")}</span>;
  if (h.state === "no_items") return <span className="tr-badge is-empty">harvested · no items</span>;
  if (h.state === "unfiled") return <span className="tr-badge is-held">{plural(h.item_count, "item")} · not filed</span>;
  return <span className="tr-badge is-none">not harvested</span>;
}

function Chips({ items, className = "tr-chips" }: { items: string[]; className?: string }) {
  if (!items.length) return null;
  return (
    <span className={className}>
      {items.map((x) => <span key={x} className="tr-chip">{x}</span>)}
    </span>
  );
}

function detailChip(r: TranscriptRow): string | undefined {
  if (r.classification !== "other" || !r.classification_detail) return undefined;
  return r.classification_detail === "no_content" ? "no content" : r.classification_detail;
}

/** The kind-specific fields of a row's meta line (design C.5). */
function RowMeta({ row, view }: { row: TranscriptRow; view: ViewId }) {
  const kind = kindOf(row);
  const dur = row.duration_s !== null ? formatDuration(row.duration_s) : undefined;
  const rate = wpm(row);
  const low = row.classification_confidence !== null && row.classification_confidence < 0.85;
  const bits: Array<string | undefined> = [dur];
  const extra: React.ReactNode[] = [];
  if (kind === "monolog") {
    if (row.word_count !== null) bits.push(`${row.word_count.toLocaleString("en-US")} words`);
    if (rate) bits.push(`${rate} wpm`);
    if (row.language) bits.push(row.language);
    if (row.source_hint) bits.push(row.source_hint);
    if ((row.speaker_count ?? 0) > 1) extra.push(<span key="spk" className="tr-flag is-warn">{row.speaker_count} speakers detected</span>);
    if (low) extra.push(<span key="low" className="tr-flag is-warn" title={`classification confidence ${row.classification_confidence}`}>low confidence</span>);
  } else if (kind === "meeting") {
    if ((row.speaker_count ?? 0) > 0) bits.push(plural(row.speaker_count ?? 0, "speaker"));
  } else if (kind === "phone_call") {
    if (row.source_hint) bits.push(row.source_hint);
  } else if (kind === "other") {
    const d = detailChip(row);
    if (d) extra.push(<span key="d" className="tr-flag">{d}</span>);
  } else {
    if (row.origin) bits.push(row.origin);
    extra.push(
      <span key="why" className="tr-flag">
        {row.classification_confidence !== null ? `classification abstained (p=${row.classification_confidence})` : "not yet classified"}
      </span>
    );
  }
  return (
    <span className="tr-meta">
      {bits.filter(Boolean).join(" · ")}
      {view === "all" ? <span className="tr-flag is-kind">{KIND_LABEL[kind]}</span> : null}
      {extra}
      {kind === "monolog" ? <Chips items={row.tags} /> : null}
      <Chips items={row.projects.length ? row.projects : row.project_ids} className="tr-chips is-projects" />
    </span>
  );
}

function summaryLines(kind: KindView): number {
  return kind === "monolog" ? 3 : kind === "meeting" ? 2 : kind === "unsorted" ? 0 : 1;
}

// ---------- expansion panel ----------

type DetailState = { status: "loading" | "ok" | "error"; data?: TranscriptDetailPayload; error?: string };

function TicketLine({ t }: { t: TranscriptTicket }) {
  const bad = t.publish_status === "blocked" || t.publish_status === "failed";
  const unfiled = !t.ticket_ref && !t.ticket_url;
  return (
    <li className="tr-ticket">
      <div className="tr-ticket-line">
        {t.ticket_url ? (
          <a className="tr-ticket-ref" href={t.ticket_url} target="_blank" rel="noopener noreferrer">{t.ticket_ref ?? "ticket"}</a>
        ) : t.ticket_ref ? (
          <span className="tr-ticket-ref">{t.ticket_ref}</span>
        ) : null}
        <span className="tr-ticket-title">{t.title}</span>
      </div>
      <div className="tr-ticket-meta">
        {t.project_id ? <span className="tr-chip">{t.project_id}</span> : null}
        {t.lane ? <span className="tr-flag" title="the lane as filed; live board state is not read">as filed: {t.lane}</span> : null}
        {t.item_status ? <span className="tr-flag">{t.item_status}</span> : null}
        {t.gate_state === "held" ? <span className="tr-flag is-held">{unfiled ? "held — not filed" : "held"}</span> : unfiled ? <span className="tr-flag">not filed</span> : null}
        {bad ? <span className="tr-flag is-bad">{t.publish_status}</span> : null}
        {t.category ? <span className="tr-flag">{t.category}</span> : null}
      </div>
      {t.quote ? (
        <details className="tr-quote">
          <summary>Evidence</summary>
          <blockquote>{t.quote}</blockquote>
        </details>
      ) : null}
    </li>
  );
}

function HarvestSection({ row, detail }: { row: TranscriptRow; detail?: DetailState }) {
  const h = row.harvest;
  const showCmd = `wax transcripts show ${row.transcript_id}`;
  return (
    <section className="tr-harvest" aria-label="Tickets from px harvest">
      <h4>Tickets from px harvest</h4>
      {detail?.status === "loading" ? <p className="tr-note">Reading tickets…</p> : null}
      {detail?.status === "error" ? <p className="hub-error" role="status"><span className="hub-label">API</span>{detail.error}</p> : null}
      {h.state === "none" && detail?.status !== "loading" ? (
        <div className="tr-note">
          <p>
            Not harvested yet. Run <code>px harvest &lt;note&gt; --publish</code>, then <code>wax transcripts link-harvest</code>.
          </p>
          <p>
            Find the note&apos;s path with <CopyRef value={showCmd} />
          </p>
        </div>
      ) : null}
      {h.state === "no_items" ? <p className="tr-note">Harvested — no action items found.</p> : null}
      {detail?.status === "ok" && detail.data && detail.data.tickets.length ? (
        <ul className="tr-tickets">
          {detail.data.tickets.map((t) => <TicketLine key={`${t.harvest_id}-${t.item_id}-${t.board_id ?? ""}`} t={t} />)}
        </ul>
      ) : null}
      {detail?.status === "ok" && detail.data && !detail.data.tickets.length && (h.state === "harvested" || h.state === "unfiled") ? (
        <p className="tr-note">The harvest run is recorded but its items are not readable yet.</p>
      ) : null}
    </section>
  );
}

function Panel({ row, detail, id }: { row: TranscriptRow; detail?: DetailState; id: string }) {
  const rate = wpm(row);
  const d = detail?.data;
  const dd: Array<[string, React.ReactNode]> = [
    ["Recorded", when(row.effective_at)],
    ["Duration", row.duration_s !== null ? formatDuration(row.duration_s) : "—"],
    ["Words", row.word_count !== null ? `${row.word_count.toLocaleString("en-US")}${rate ? ` · ${rate} wpm` : ""}` : "—"],
    ["Speakers", row.speaker_count ? `${row.speaker_count}${row.diarized ? " (diarized)" : ""}` : row.diarized ? "diarized" : "—"],
    ["Language", row.language ?? "—"],
    ["Source", [row.origin, row.source_hint].filter(Boolean).join(" · ") || "—"],
    [
      "Kind",
      `${row.classification ? KIND_LABEL[row.classification] : "Unsorted"}${row.classification_detail ? ` · ${row.classification_detail}` : ""}${row.classification_confidence !== null ? ` · p=${row.classification_confidence}` : ""}${row.classification_source ? ` · ${row.classification_source}` : ""}`
    ],
    ["Audio", row.audio_available ? "backed up" : "not backed up"]
  ];
  return (
    <div className="tr-panel" id={id}>
      {row.summary ? <p className="tr-full-summary">{row.summary}</p> : null}
      <dl className="tr-dl">
        {dd.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
        {row.tags.length ? <div><dt>Tags</dt><dd><Chips items={row.tags} /></dd></div> : null}
        {row.project_ids.length ? <div><dt>Projects</dt><dd><Chips items={row.projects.length ? row.projects : row.project_ids} className="tr-chips is-projects" /></dd></div> : null}
      </dl>
      <div className="tr-refs">
        {row.wax_item_id ? <CopyRef value={row.wax_item_id} label={`item ${row.wax_item_id.slice(0, 12)}`} /> : null}
        <CopyRef value={`wax transcripts show ${row.transcript_id}`} />
      </div>
      {d?.pass_history.length ? (
        <p className="tr-passes" aria-label="Pass history">
          {d.pass_history.map((p) => (
            <span key={`${p.slug}-${p.pass_version}`} className={`tr-pass is-${p.state ?? "unknown"}`} title={p.finished_at ?? undefined}>
              {p.slug} v{p.pass_version ?? "?"} · {p.state ?? "?"}
            </span>
          ))}
        </p>
      ) : null}
      <HarvestSection row={row} detail={detail} />
    </div>
  );
}

// ---------- rows ----------

type RowProps = {
  row: TranscriptRow;
  view: ViewId;
  open: boolean;
  detail?: DetailState;
  hit?: SearchHit;
  onToggle: () => void;
  scope: string;
};

function ListRow({ row, view, open, detail, hit, onToggle, scope }: RowProps) {
  const kind = kindOf(row);
  const lines = summaryLines(kind);
  const panelId = `tr-panel-${scope}-${row.transcript_id}`;
  return (
    <article className={`tr-row is-${kind}${open ? " is-open" : ""}`} data-transcript-id={row.transcript_id}>
      <button type="button" className="tr-row-head" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle}>
        <span className="tr-when">{when(row.effective_at)}</span>
        <span className="tr-main">
          <span className="tr-title">{row.title}</span>
          {hit?.snippet ? <span className="tr-snippet"><Marked text={hit.snippet} /></span> : null}
          {!open && row.summary && lines > 0 ? <span className="tr-summary" style={{ WebkitLineClamp: lines }}>{row.summary}</span> : null}
          <RowMeta row={row} view={view} />
        </span>
        <span className="tr-end"><HarvestBadge row={row} /></span>
      </button>
      {open ? <Panel row={row} detail={detail} id={panelId} /> : null}
    </article>
  );
}

function CardLine({ row, view, open, detail, onToggle, scope }: RowProps) {
  const panelId = `tr-panel-${scope}-${row.transcript_id}`;
  const kind = kindOf(row);
  return (
    <li className={`tr-line${open ? " is-open" : ""}`} data-transcript-id={row.transcript_id}>
      <button type="button" className="tr-line-head" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle}>
        <span className="tr-line-time">{clock(row.effective_at)}</span>
        <span className="tr-line-title">{row.title}</span>
        {view === "all" ? <span className="tr-flag is-kind">{KIND_LABEL[kind]}</span> : null}
        <span className={`tr-dot${harvested(row) ? " is-harvested" : ""}`} title={harvested(row) ? "harvested" : "not harvested"} aria-label={harvested(row) ? "harvested" : "not harvested"} />
      </button>
      {open ? <Panel row={row} detail={detail} id={panelId} /> : null}
    </li>
  );
}

// ---------- project cards ----------

type Card = { key: string; name: string; rows: TranscriptRow[]; unassigned?: boolean };

function buildCards(rows: TranscriptRow[], names: Map<string, string>): Card[] {
  const map = new Map<string, Card>();
  const unassigned: TranscriptRow[] = [];
  for (const r of rows) {
    if (!r.project_ids.length) {
      unassigned.push(r);
      continue;
    }
    r.project_ids.forEach((pid, i) => {
      const card = map.get(pid) ?? { key: pid, name: r.projects[i] ?? names.get(pid) ?? pid, rows: [] };
      card.rows.push(r);
      map.set(pid, card);
    });
  }
  const cards = [...map.values()];
  for (const c of cards) c.rows.sort(byNewest);
  cards.sort((a, b) => (b.rows[0]?.effective_at ?? "").localeCompare(a.rows[0]?.effective_at ?? "") || a.name.localeCompare(b.name));
  unassigned.sort(byNewest);
  cards.push({ key: "__unassigned", name: "Unassigned", rows: unassigned, unassigned: true });
  return cards;
}

function ProjectCard({ card, view, openId, details, onToggle }: {
  card: Card; view: ViewId; openId?: number; details: Record<number, DetailState>; onToggle: (id: number, card: string) => void;
}) {
  const days: Array<{ label: string; rows: TranscriptRow[] }> = [];
  for (const r of card.rows) {
    const label = dayLabel(r.effective_at);
    const last = days[days.length - 1];
    if (last && last.label === label) last.rows.push(r);
    else days.push({ label, rows: [r] });
  }
  const done = card.rows.filter(harvested).length;
  return (
    <section className={`tr-card${card.unassigned ? " is-unassigned" : ""}`} aria-label={`${card.name}, ${plural(card.rows.length, "recording")}`}>
      <header className="tr-card-head">
        <h3>{card.name}</h3>
        <span className="tr-card-count">{card.rows.length}</span>
        <span className="tr-card-tally">{done ? `${done} harvested` : "none harvested"}</span>
      </header>
      <div className="tr-card-body">
        {card.rows.length === 0 ? <p className="tr-note">Nothing here.</p> : null}
        {days.map((day) => (
          <div key={day.label} className="tr-day">
            <h4>{day.label}</h4>
            <ul>
              {day.rows.map((r) => (
                <CardLine
                  key={r.transcript_id}
                  row={r}
                  view={view}
                  scope={card.key}
                  open={openId === r.transcript_id}
                  detail={details[r.transcript_id]}
                  onToggle={() => onToggle(r.transcript_id, card.key)}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- the app ----------

export function TranscriptsApp() {
  const [theme, toggleTheme] = useTheme();
  const [state, setState] = useState<UrlState>({ view: "monolog", group: "list", q: "", hermes: false });
  const [ready, setReady] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [details, setDetails] = useState<Record<number, DetailState>>({});
  const [hits, setHits] = useState<{ query: string; list: SearchHit[]; error?: string } | undefined>();
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

  const update = useCallback((patch: Partial<UrlState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      // "All kinds" only exists in project mode.
      if (next.group === "list" && next.view === "all") next.view = "monolog";
      writeUrl(next);
      return next;
    });
  }, []);

  const list = usePoll<TranscriptsPayload>(`/api/modules/transcripts/list?include_hermes=${state.hermes ? 1 : 0}`, POLL_MS);
  const data = list.data;

  // Debounced lexical search (read-only; no embedding call on each keystroke).
  useEffect(() => {
    if (!ready) return;
    const q = searchText.trim();
    const t = setTimeout(() => update({ q }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchText, ready, update]);

  const searchView = state.view !== "all" && state.view !== "unsorted" ? state.view : undefined;
  useEffect(() => {
    if (!state.q) {
      setHits(undefined);
      return;
    }
    const ctl = new AbortController();
    const params = new URLSearchParams({ q: state.q });
    if (searchView) params.set("view", searchView);
    (async () => {
      try {
        const res = await fetch(`/api/modules/transcripts/search?${params}`, { cache: "no-store", signal: ctl.signal });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = (await res.json()) as TranscriptSearchPayload;
        setHits({ query: state.q, list: body.results, ...(body.source.down ? { error: body.source.detail ?? "search is down" } : {}) });
      } catch (err) {
        if (!ctl.signal.aborted) setHits({ query: state.q, list: [], error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => ctl.abort();
  }, [state.q, searchView]);

  // The expanded row's tickets.
  useEffect(() => {
    const id = state.open;
    if (!id) return;
    const ctl = new AbortController();
    setDetails((d) => ({ ...d, [id]: { status: "loading", data: d[id]?.data } }));
    (async () => {
      try {
        const res = await fetch(`/api/modules/transcripts/${id}`, { cache: "no-store", signal: ctl.signal });
        if (!res.ok) throw new Error(res.status === 404 ? `no transcript #${id}` : `${res.status} ${res.statusText}`);
        const body = (await res.json()) as TranscriptDetailPayload;
        if (body.source.down && !body.row) throw new Error(body.source.detail ?? "the transcript store is not answering");
        setDetails((d) => ({ ...d, [id]: { status: "ok", data: body } }));
      } catch (err) {
        if (!ctl.signal.aborted) setDetails((d) => ({ ...d, [id]: { status: "error", error: err instanceof Error ? err.message : String(err) } }));
      }
    })();
    return () => ctl.abort();
  }, [state.open]);

  const rows = useMemo(() => [...(data?.rows ?? [])].sort(byNewest), [data]);
  const names = useMemo(() => new Map((data?.projects ?? []).map((p) => [p.project_id, p.name])), [data]);
  const anyProject = rows.some((r) => r.project_ids.length > 0);

  const visible = useMemo(() => {
    let out = state.view === "all" ? rows : rows.filter((r) => kindOf(r) === state.view);
    if (state.q && hits && hits.query === state.q) {
      const rank = new Map(hits.list.map((h, i) => [h.transcript_id, i]));
      out = out.filter((r) => rank.has(r.transcript_id));
      if (state.group === "list") out = [...out].sort((a, b) => (rank.get(a.transcript_id) ?? 0) - (rank.get(b.transcript_id) ?? 0));
    }
    return out;
  }, [rows, state.view, state.q, state.group, hits]);
  const hitById = useMemo(() => new Map((hits?.list ?? []).map((h) => [h.transcript_id, h])), [hits]);
  const searching = state.q !== "" && (!hits || hits.query !== state.q);

  const counts = data?.counts ?? {};
  const tabs: Array<{ id: ViewId; label: string; count?: number }> = [
    ...(state.group === "project" ? [{ id: "all" as ViewId, label: "All kinds", count: rows.length }] : []),
    ...KIND_ORDER.filter((k) => k !== "unsorted" || (counts.unsorted ?? 0) > 0 || state.view === "unsorted").map((k) => ({ id: k as ViewId, label: KIND_LABEL[k], count: counts[k] ?? 0 }))
  ];

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === state.view);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    update({ view: tabs[next].id, open: undefined });
    tabRefs.current[tabs[next].id]?.focus();
  };

  const toggle = (id: number) => update({ open: state.open === id ? undefined : id });

  const sources: Source[] = data
    ? [{ name: data.source.name, value: data.source.value, down: data.source.down, detail: data.source.detail, ageSeconds: sinceSeconds(data.generated_at, Date.now()) }]
    : [];

  const cards = useMemo(() => (state.group === "project" ? buildCards(visible, names) : []), [state.group, visible, names]);
  const kindWord = state.view === "all" ? "recordings" : KIND_NOUN[state.view][1] === "other" ? "other recordings" : KIND_NOUN[state.view][1];

  return (
    <div className="hub-root" data-theme={theme}>
      <header className="hub-header">
        <Brand />
        <HubTabs current="transcripts" />
        <div className="hub-header-end">
          <SourceStrip sources={sources} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="hub-body">
        <div className="hub-lede">
          <p className="hub-statement" aria-live="polite">
            {data ? statement(data) : list.error ? "The Holocene API is not answering." : "Reading the transcript store…"}
          </p>
          {data?.source.down && data.source.detail ? (
            <p className="hub-error" role="status"><span className="hub-label">Wax</span>{data.source.detail}</p>
          ) : null}
          {list.error ? (
            <p className="hub-error" role="status">
              <span className="hub-label">API</span>
              {data ? `Showing the last good read. ${list.error}` : list.error}
            </p>
          ) : null}
        </div>

        <div className="tr-controls">
          <div className="tr-tabs" role="tablist" aria-label="Kind of recording" onKeyDown={onTabKey}>
            {tabs.map((t) => (
              <button
                key={t.id}
                ref={(el) => { tabRefs.current[t.id] = el; }}
                type="button"
                role="tab"
                id={`tr-tab-${t.id}`}
                aria-selected={state.view === t.id}
                aria-controls="tr-results"
                tabIndex={state.view === t.id ? 0 : -1}
                className="tr-tab"
                onClick={() => update({ view: t.id, open: undefined })}
              >
                {t.label}
                {data ? <span className="tr-tab-count">{t.count}</span> : null}
              </button>
            ))}
          </div>

          <div className="tr-controls-end">
            <div className="tr-group" role="group" aria-label="Grouping">
              {(["list", "project"] as const).map((g) => (
                <button key={g} type="button" className="tr-seg" aria-pressed={state.group === g} onClick={() => update({ group: g, open: undefined })}>
                  {g === "list" ? "List" : "By project"}
                </button>
              ))}
            </div>
            <input
              type="search"
              className="tr-search"
              placeholder="Search transcripts"
              aria-label="Search transcripts"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
            <label className="tr-check">
              <input type="checkbox" checked={state.hermes} onChange={(e) => update({ hermes: e.target.checked, open: undefined })} />
              Show hermes voice commands
              {!state.hermes && counts.hidden_hermes ? <span className="tr-check-count">{counts.hidden_hermes} hidden</span> : null}
            </label>
          </div>
        </div>

        {state.q ? (
          <p className="tr-searchline" role="status">
            {searching ? "Searching…" : hits?.error ? `Search failed: ${hits.error}` : `${plural(visible.length, "match", "matches")} for “${state.q}” in ${kindWord}.`}
          </p>
        ) : null}

        <div id="tr-results" role="tabpanel" aria-labelledby={`tr-tab-${state.view}`} className="tr-results">
          {!data ? (
            <div className="hub-placeholder">
              <span className="hub-label">{list.error ? "No data" : "Loading"}</span>
              <p>{list.error ? `GET /api/modules/transcripts/list failed: ${list.error}` : "Reading the transcript store…"}</p>
            </div>
          ) : state.group === "project" ? (
            <>
              {!anyProject && !data.source.down ? (
                <div className="hub-placeholder tr-slim">
                  <span className="hub-label">No projects yet</span>
                  <p>No recordings have a project yet, so everything is unassigned.</p>
                </div>
              ) : null}
              <div className="tr-grid">
                {cards
                  .filter((c) => !c.unassigned || c.rows.length > 0 || cards.length === 1)
                  .map((c) => (
                    <ProjectCard
                      key={c.key}
                      card={c}
                      view={state.view}
                      openId={state.open}
                      details={details}
                      onToggle={(id) => toggle(id)}
                    />
                  ))}
              </div>
            </>
          ) : visible.length ? (
            <div className="tr-list">
              {visible.map((r) => (
                <ListRow
                  key={r.transcript_id}
                  row={r}
                  view={state.view}
                  scope="list"
                  open={state.open === r.transcript_id}
                  detail={details[r.transcript_id]}
                  hit={hitById.get(r.transcript_id)}
                  onToggle={() => toggle(r.transcript_id)}
                />
              ))}
            </div>
          ) : data.source.down ? null : searching ? null : (
            <div className="hub-placeholder">
              <span className="hub-label">Empty view</span>
              <p>{state.q ? `No ${kindWord} match “${state.q}”.` : `No ${kindWord}.`}</p>
            </div>
          )}
          {data?.truncated ? <p className="tr-note">Showing the newest {rows.length} recordings; older ones are not loaded.</p> : null}
        </div>

        <footer className="hub-foot">
          <span>Read-only. Holocene never runs a harvest; <code>px harvest</code> and <code>wax transcripts link-harvest</code> do.</span>
        </footer>
      </div>
    </div>
  );
}

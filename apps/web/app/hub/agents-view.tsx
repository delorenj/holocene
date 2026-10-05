"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { rectOf, stackPath, treePath, useDrag, usePositions, type Pos, type Rect } from "./canvas";
import { Age, BandTrack, BoxIcon, CopyRef, Glyph, formatDuration, signalWord, sinceSeconds } from "./ui";
import type { Agent, AgentsPayload, Contractor, HubEvent, Signal } from "./types";

type NodeKind = "ceo" | "director" | "pm" | "contractor" | "inactive";
type LaidNode = { id: string; kind: NodeKind; x: number; y: number; w: number; h: number; agent?: Agent; contractor?: Contractor };
type LaidEdge = { id: string; from: string; to: string; shape: "tree" | "stack"; inferred: boolean };

const SIZE = { ceo: [160, 48], director: [208, 112], pm: [192, 112], contractor: [168, 80], inactive: [216, 0] } as const;
const ORDER: Signal[] = ["you", "broken", "stuck", "working", "unknown", "quiet", "cleared"];
const PM_ROW_GAP = 24;

function bySignal(a: Agent, b: Agent) {
  return ORDER.indexOf(a.signal) - ORDER.indexOf(b.signal) || a.name.localeCompare(b.name);
}

function inactiveHeight(rows: number) {
  return 82 + rows * 18;
}

/** Tidy tree: You at the top, directors under you, active PMs under their director, contractors stacked under each PM. */
function layout(data: AgentsPayload, openInactive: boolean): { nodes: LaidNode[]; edges: LaidEdge[]; inactive: Agent[]; w: number; h: number } {
  const contractorsByParent = new Map<string, Contractor[]>();
  for (const c of data.contractors) contractorsByParent.set(c.parent, [...(contractorsByParent.get(c.parent) ?? []), c]);
  const visible = data.agents.filter((a) => a.role === "director" || a.active);
  const visibleIds = new Set(visible.map((a) => a.id));
  const inactive = data.agents
    .filter((a) => !visibleIds.has(a.id))
    .sort((a, b) => (Date.parse(b.lastActiveAt ?? "") || 0) - (Date.parse(a.lastActiveAt ?? "") || 0));
  const parentOf = (a: Agent) => (visibleIds.has(a.reportsTo) && a.reportsTo !== a.id ? a.reportsTo : "ceo");
  const kids = new Map<string, Agent[]>();
  for (const a of visible) kids.set(parentOf(a), [...(kids.get(parentOf(a)) ?? []), a]);
  for (const list of kids.values()) list.sort((a, b) => (a.role === b.role ? bySignal(a, b) : a.role === "director" ? -1 : 1));

  const directorDepth = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    if (id === "ceo" || seen.has(id)) return 0;
    seen.add(id);
    const agent = visible.find((a) => a.id === id);
    return agent ? 1 + depthOf(parentOf(agent), seen) : 0;
  };
  for (const a of visible) if (a.role === "director") directorDepth.set(a.id, depthOf(a.id));
  const directorRows = Math.max(0, ...directorDepth.values());
  const rowY = (depth: number) => 120 + (depth - 1) * 152;
  const pmY = directorRows ? rowY(directorRows) + SIZE.director[1] + 40 : 120;

  const widths = new Map<string, number>();
  const widthOf = (id: string, kind: NodeKind): number => {
    const children = kids.get(id) ?? [];
    const own = kind === "ceo" ? SIZE.ceo[0] : kind === "director" ? SIZE.director[0] : SIZE.pm[0];
    if (kind === "pm" || !children.length) return widths.set(id, own).get(id)!;
    const sum = children.reduce((s, c) => s + widthOf(c.id, c.role), 0) + PM_ROW_GAP * (children.length - 1);
    return widths.set(id, Math.max(own, sum)).get(id)!;
  };
  const total = widthOf("ceo", "ceo");

  const nodes: LaidNode[] = [];
  const edges: LaidEdge[] = [];
  const place = (id: string, kind: NodeKind, x0: number, agent?: Agent) => {
    const w = widths.get(id) ?? SIZE.pm[0];
    const [nw, nh] = SIZE[kind];
    const y = kind === "ceo" ? 24 : kind === "director" ? rowY(directorDepth.get(id) ?? 1) : pmY;
    const self: LaidNode = { id, kind, x: Math.round(x0 + (w - nw) / 2), y, w: nw, h: nh, agent };
    nodes.push(self);
    let cx = x0;
    for (const child of kids.get(id) ?? []) {
      place(child.id, child.role, cx, child);
      edges.push({ id: `${id}>${child.id}`, from: id, to: child.id, shape: "tree", inferred: child.reportsBasis !== "recorded" });
      cx += (widths.get(child.id) ?? SIZE.pm[0]) + PM_ROW_GAP;
    }
    if (kind === "pm" || kind === "director") {
      (contractorsByParent.get(id) ?? []).forEach((c, i) => {
        const [cw, ch] = SIZE.contractor;
        nodes.push({ id: c.id, kind: "contractor", x: self.x + 24, y: self.y + self.h + 24 + i * (ch + 12), w: cw, h: ch, contractor: c });
        edges.push({ id: `${id}>${c.id}`, from: id, to: c.id, shape: "stack", inferred: c.via === "scope" });
      });
    }
  };
  place("ceo", "ceo", 24);

  const rows = openInactive ? inactive.length : Math.min(3, inactive.length);
  if (inactive.length) nodes.push({ id: "inactive", kind: "inactive", x: 24 + total + 48, y: 120, w: SIZE.inactive[0], h: inactiveHeight(rows) });
  const w = Math.max(...nodes.map((n) => n.x + n.w)) + 48;
  const h = Math.max(...nodes.map((n) => n.y + n.h)) + 48;
  return { nodes, edges, inactive, w, h };
}

type Dot = { key: string; d: string; kind: HubEvent["kind"]; up: boolean };

export function AgentsView({
  data,
  now,
  onOpenProject,
  focus,
  onFocus
}: {
  data: AgentsPayload;
  now: number;
  onOpenProject: (projectId: string) => void;
  focus?: string;
  onFocus: (id: string) => void;
}) {
  const [openInactive, setOpenInactive] = useState(false);
  const [motion, setMotion] = useState(true);
  const { overrides, place, commit, reset } = usePositions("holocene.hub.agents.positions");
  const laid = useMemo(() => layout(data, openInactive), [data, openInactive]);
  const posOf = (n: LaidNode): Pos => overrides[n.id] ?? { x: n.x, y: n.y };
  const rects = new Map<string, Rect>(laid.nodes.map((n) => [n.id, rectOf(posOf(n), n.w, n.h)]));
  const edgePath = (e: LaidEdge) => {
    const a = rects.get(e.from);
    const b = rects.get(e.to);
    return a && b ? (e.shape === "stack" ? stackPath(a, b) : treePath(a, b)) : "";
  };

  const defaultSel = useMemo(() => {
    const waiting = data.agents.find((a) => a.signal === "you");
    const active = data.agents.filter((a) => a.active && a.role === "pm").sort(bySignal)[0];
    return (waiting ?? active ?? data.agents.find((a) => a.role === "director") ?? data.agents[0])?.id ?? "ceo";
  }, [data]);
  const sel = focus && (rects.has(focus) || data.agents.some((a) => a.id === focus)) ? focus : defaultSel;
  const select = (id: string) => {
    if (id === "inactive") setOpenInactive((v) => !v);
    onFocus(id);
  };
  const handlers = useDrag(place, commit, select);

  // Delegation dots for events that arrived since the last poll.
  const seen = useRef<Set<string> | null>(null);
  const [dots, setDots] = useState<Dot[]>([]);
  useEffect(() => {
    const fresh: HubEvent[] = [];
    if (!seen.current) {
      seen.current = new Set();
      for (const e of data.events) {
        seen.current.add(e.id);
        if (now - Date.parse(e.at) < 20_000) fresh.push(e);
      }
    } else {
      for (const e of data.events) if (!seen.current.has(e.id)) (seen.current.add(e.id), fresh.push(e));
    }
    if (!motion || !fresh.length) return;
    const timers = fresh.slice(-6).map((e, i) =>
      setTimeout(() => {
        const down = e.kind === "delegated";
        const edgeId = down ? `${e.from}>${e.to}` : `${e.to}>${e.from}`;
        const edge = laid.edges.find((x) => x.id === edgeId);
        if (!edge) return;
        setDots((prev) => [...prev, { key: `${e.id}:${Date.now()}`, d: edgePath(edge), kind: e.kind, up: !down }]);
      }, i * 650)
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.events, motion]);
  const lastEvent = data.events.at(-1);

  const selNode = laid.nodes.find((n) => n.id === sel);
  const selAgent = data.agents.find((a) => a.id === sel);
  const selContractor = data.contractors.find((c) => c.id === sel);

  return (
    <div className="hub-main">
      <section className="hub-canvas-panel" aria-label="Agent canvas">
        <div className="hub-toolbar">
          <button type="button" className="hub-btn" onClick={() => setMotion((m) => !m)}>{motion ? "Pause motion" : "Resume motion"}</button>
          <button type="button" className="hub-btn is-ghost" onClick={reset}>Reset layout</button>
        </div>
        <div className="hub-canvas">
          <div className="hub-host" style={{ width: Math.max(laid.w, ...[...rects.values()].map((r) => r.r + 48)), height: Math.max(laid.h, ...[...rects.values()].map((r) => r.b + 48)) }}>
            <svg className="hub-edges" aria-hidden="true">
              {laid.edges.map((e) => {
                const hot = e.from === sel || e.to === sel;
                return <path key={e.id} d={edgePath(e)} className={`hub-edge${e.inferred ? " is-inferred" : ""}${hot ? " is-hot" : ""}`} />;
              })}
            </svg>
            {dots.map((dot) => (
              <span
                key={dot.key}
                className={`hub-dot tone-${dot.kind}`}
                style={{ offsetPath: `path('${dot.d}')`, animationDirection: dot.up ? "reverse" : "normal" }}
                onAnimationEnd={() => setDots((prev) => prev.filter((d) => d.key !== dot.key))}
              />
            ))}
            {laid.nodes.map((n) => {
              const p = posOf(n);
              return (
                <button
                  key={n.id}
                  type="button"
                  className={`hub-node kind-${n.kind}${n.agent?.signal === "you" ? " is-you" : ""}`}
                  aria-pressed={n.id === sel}
                  aria-label={nodeLabel(n, laid.inactive.length)}
                  style={{ left: p.x, top: p.y, width: n.w, height: n.h }}
                  {...handlers(n.id, p)}
                >
                  <NodeBody node={n} now={now} inactive={laid.inactive} open={openInactive} />
                </button>
              );
            })}
          </div>
        </div>
        <footer className="hub-legend">
          <span className="hub-key"><i className="key-line" />Link recorded on the bus</span>
          <span className="hub-key"><i className="key-line is-inferred" />Link inferred: registry, repo path or unit name</span>
          <span className="hub-key"><i className="key-dot tone-delegated" />Delegated</span>
          <span className="hub-key"><i className="key-dot tone-responded" />Responded</span>
          <span className="hub-key"><i className="key-dot tone-failed" />Failed</span>
          <span className="hub-last" aria-live="polite">{lastEvent ? `${lastEvent.text} · ${formatDuration(sinceSeconds(lastEvent.at, now) ?? 0)} ago` : "No agent.invocation events in the last 10 minutes"}</span>
        </footer>
      </section>

      <aside className="hub-inspector" aria-label="Selected agent">
        {selNode?.kind === "ceo" || sel === "ceo" ? (
          <CeoPanel data={data} onFocus={onFocus} />
        ) : sel === "inactive" ? (
          <InactivePanel inactive={laid.inactive} now={now} total={data.agents.length} onOpenProject={onOpenProject} />
        ) : selContractor ? (
          <ContractorPanel c={selContractor} parent={data.agents.find((a) => a.id === selContractor.parent)} now={now} onFocus={onFocus} onOpenProject={onOpenProject} />
        ) : selAgent ? (
          <AgentPanel a={selAgent} data={data} now={now} onFocus={onFocus} onOpenProject={onOpenProject} />
        ) : (
          <p className="hub-note">Nothing selected.</p>
        )}
      </aside>
    </div>
  );
}

function nodeLabel(n: LaidNode, inactiveCount: number) {
  if (n.kind === "ceo") return "You, CEO";
  if (n.kind === "inactive") return `Inactive agents, ${inactiveCount}`;
  if (n.contractor) return `${n.contractor.ticket ?? "contractor"}, ${n.contractor.state}`;
  const a = n.agent!;
  return `${a.name}, ${a.state}${a.project ? `, project ${a.project.id}` : ", no project record"}`;
}

function NodeBody({ node, now, inactive, open }: { node: LaidNode; now: number; inactive: Agent[]; open: boolean }) {
  if (node.kind === "ceo") {
    return (
      <span className="node-row">
        <span className="node-name">You</span>
        <span className="node-sub">CEO</span>
      </span>
    );
  }
  if (node.kind === "inactive") {
    const rows = open ? inactive : inactive.slice(0, 3);
    return (
      <>
        <span className="node-row">
          <Glyph signal="quiet" />
          <span className="node-name">Inactive agents</span>
          <span className="node-count">{inactive.length}</span>
        </span>
        <span className="node-sub">Most recent first</span>
        <span className="node-list">
          {rows.map((a) => (
            <span key={a.id} className={`node-list-row${a.project ? "" : " is-unlinked"}`}>
              <span>{a.id}</span>
              <span>{a.lastActiveAt ? formatDuration(sinceSeconds(a.lastActiveAt, now) ?? 0) : "never"}</span>
            </span>
          ))}
        </span>
        <span className="node-more">{open ? "Click to fold" : inactive.length > 3 ? `${inactive.length - 3} more · click to open` : "Click to open"}</span>
      </>
    );
  }
  if (node.contractor) {
    const c = node.contractor;
    return (
      <>
        <span className="node-row">
          <Glyph signal="working" />
          <span className="node-name">{c.ticket ?? (c.via === "scope" ? "worker" : "subagent")}</span>
          <Age seconds={sinceSeconds(c.startedAt, now)} />
        </span>
        <span className="node-state">{c.via === "scope" ? "running · worker scope" : "open · subagent"}</span>
        <span className="node-sub">hermes · ephemeral</span>
      </>
    );
  }
  const a = node.agent!;
  return (
    <>
      <span className="node-row">
        <Glyph signal={a.signal} title={a.state} />
        <span className="node-name">{a.name}</span>
        <Age seconds={a.heldSeconds} />
      </span>
      <span className="node-sub">{a.role === "director" ? `director · ${a.id}` : a.id}</span>
      <span className="node-row">
        {a.project ? (
          <span className={`node-chip${a.project.indexed && a.project.basis === "project_path" ? "" : " is-soft"}`}>
            <BoxIcon />
            <span>{a.project.id}</span>
          </span>
        ) : (
          <span className="node-chip is-missing">no project record</span>
        )}
      </span>
      <span className={`node-state sig-text-${a.signal}`}>
        {[a.ticket?.key, a.state, a.blockKind].filter(Boolean).join(" · ")}
      </span>
    </>
  );
}

function stateText(a: Agent) {
  return [a.state, a.blockKind].filter(Boolean).join(" · ");
}

function basisText(a: Agent) {
  const p = a.project!;
  const how = p.basis === "project_path" ? "Matched on project_path." : p.basis === "repo" ? "Matched on repo name only." : "Matched on the Plane board id.";
  const mismatch = p.basis === "project_path" && p.id !== a.id.replace(/-pm$/, "") ? ` The project id is ${p.id}, so a name match would miss it.` : "";
  return `${how}${mismatch}${p.indexed ? "" : " Not in the pjangler index yet; read from .project.json in the repo."}`;
}

function ProjectBlock({ label, a, onOpenProject, note }: { label: string; a: Agent; onOpenProject: (id: string) => void; note?: string }) {
  const p = a.project;
  if (!p) {
    return (
      <div className="hub-missing">
        <Glyph signal="unknown" size={8} />
        <span>No project record. Nothing in pjangler matches this agent&rsquo;s project_path or repo name.</span>
      </div>
    );
  }
  return (
    <section className="hub-link-block" aria-label="Attached project">
      <div className="link-head">
        <span className="hub-label">{label}</span>
        <span className="link-source">pjangler</span>
      </div>
      <div className="link-title">
        <BoxIcon size={16} />
        <button type="button" className="hub-textlink" onClick={() => onOpenProject(p.id)}>{p.name}</button>
        <span className="link-id">{p.id}</span>
        {p.status ? <span className="link-status">{p.status}</span> : null}
      </div>
      <dl className="link-facts">
        <dt>Board</dt>
        <dd>{p.board ? `${p.board}${p.workspace ? ` · Plane workspace ${p.workspace}` : ""}` : "not bound"}</dd>
        <dt>Repo</dt>
        <dd><CopyRef value={p.repoPath} /></dd>
      </dl>
      <p className="link-basis">
        <Glyph signal={p.indexed ? "quiet" : "stuck"} size={8} />
        <span>{note ?? basisText(a)}</span>
      </p>
    </section>
  );
}

function AgentPanel({ a, data, now, onFocus, onOpenProject }: { a: Agent; data: AgentsPayload; now: number; onFocus: (id: string) => void; onOpenProject: (id: string) => void }) {
  const boss = data.agents.find((x) => x.id === a.reportsTo);
  const kids = data.contractors.filter((c) => c.parent === a.id);
  const directs = data.agents.filter((x) => x.reportsTo === a.id);
  return (
    <>
      <header className="insp-head">
        <span className="hub-label">{a.role === "director" ? "Director" : "Project manager"}</span>
        <div className="insp-title">
          <Glyph signal={a.signal} size={12} title={a.state} />
          <h2>{a.name}</h2>
          <Age seconds={a.heldSeconds} verb="held" />
        </div>
        <span className="insp-id">{a.id}{a.role === "director" && a.declaredRole !== "director" ? ` · registry role ${a.declaredRole}` : ""}</span>
        <span className={`insp-state sig-text-${a.signal}`}>{stateText(a)} · {signalWord(a.signal)}</span>
        <span className="insp-meta">gateway {a.gateway}{a.tools !== undefined ? ` · ${a.tools} tools` : ""}{a.subs ? ` · ${a.subs} subagent lanes` : ""}</span>
      </header>
      <ProjectBlock label={a.role === "director" ? "Directs project" : "Attached to"} a={a} onOpenProject={onOpenProject} />
      <div className="insp-section">
        <span className="hub-label">Reports to</span>
        <button type="button" className="hub-row" onClick={() => onFocus(boss ? boss.id : "ceo")}>
          {boss ? <Glyph signal={boss.signal} size={8} /> : <Glyph signal="quiet" size={8} />}
          <span className="row-name">{boss ? boss.name : "You"}</span>
          <span className="row-meta">{a.reportsBasis === "recorded" ? "reports_to in the registry" : boss ? "inferred: repo sits under its project" : "no director above it"}</span>
        </button>
      </div>
      {a.ticket ? (
        <div className="insp-section">
          <span className="hub-label">Working on</span>
          <div className="ticket-line">
            <CopyRef value={a.ticket.key} />
            <span>{a.ticket.title}</span>
          </div>
          <BandTrack ticket={a.ticket} />
          <span className="insp-meta">{[a.ticket.state, ...a.ticket.labels].filter(Boolean).join(" · ") || "No Plane state seen yet"}</span>
          <span className="hub-note">Plane lifecycle band. Krebs phases show here once Krebs emits them.</span>
        </div>
      ) : null}
      {kids.length ? (
        <div className="insp-section">
          <span className="hub-label">Contractors · {kids.length}</span>
          {kids.map((c) => (
            <button key={c.id} type="button" className="hub-row" onClick={() => onFocus(c.id)}>
              <Glyph signal="working" size={8} />
              <span className="row-name">{c.ticket ?? c.ref}</span>
              <span className="row-meta">{c.via === "scope" ? "worker scope" : "subagent"} · {formatDuration(sinceSeconds(c.startedAt, now) ?? 0)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {a.role === "director" && directs.length ? (
        <div className="insp-section">
          <span className="hub-label">Directs · {directs.length}</span>
          {directs.map((d) => (
            <button key={d.id} type="button" className="hub-row" onClick={() => onFocus(d.id)}>
              <Glyph signal={d.signal} size={8} />
              <span className="row-name">{d.name}</span>
              <span className="row-meta">{d.project?.id ?? "no project record"} · {d.state}</span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function ContractorPanel({ c, parent, now, onFocus, onOpenProject }: { c: Contractor; parent?: Agent; now: number; onFocus: (id: string) => void; onOpenProject: (id: string) => void }) {
  return (
    <>
      <header className="insp-head">
        <span className="hub-label">Contractor · ephemeral</span>
        <div className="insp-title">
          <Glyph signal="working" size={12} />
          <h2>{c.ticket ? `${c.ticket} contractor` : c.via === "scope" ? "Worker scope" : "Subagent"}</h2>
          <Age seconds={sinceSeconds(c.startedAt, now)} verb="up" />
        </div>
        <span className="insp-id">{c.ref}</span>
        <span className="insp-state">{c.via === "scope" ? "running · systemd scope, no ASM state of its own" : "open · since agent.invocation.started"}</span>
      </header>
      {parent ? <ProjectBlock label="Inherits project" a={parent} onOpenProject={onOpenProject} note={`From ${parent.name}. Contractors have no registry row.`} /> : null}
      {parent ? (
        <div className="insp-section">
          <span className="hub-label">Delegated by</span>
          <button type="button" className="hub-row" onClick={() => onFocus(parent.id)}>
            <Glyph signal={parent.signal} size={8} />
            <span className="row-name">{parent.name}</span>
            <span className="row-meta">{c.via === "scope" ? "--profile in the unit description" : "parent_invocation_id"}</span>
          </button>
        </div>
      ) : null}
      {c.description ? (
        <div className="insp-section">
          <span className="hub-label">Unit description</span>
          <code className="hub-code">{c.description}</code>
        </div>
      ) : null}
      <p className="hub-note">Stateless: no memory and no registry row. It leaves the canvas when its {c.via === "scope" ? "scope exits" : "parent completes it"}.</p>
    </>
  );
}

function CeoPanel({ data, onFocus }: { data: AgentsPayload; onFocus: (id: string) => void }) {
  const ids = new Set(data.agents.map((a) => a.id));
  const direct = data.agents.filter((a) => (a.reportsTo === "ceo" || !ids.has(a.reportsTo)) && (a.active || a.role === "director"));
  return (
    <>
      <header className="insp-head">
        <span className="hub-label">Operator</span>
        <div className="insp-title"><h2>You</h2></div>
        <span className="insp-id">CEO</span>
      </header>
      <div className="insp-section">
        <span className="hub-label">Reports to you</span>
        {direct.map((a) => (
          <button key={a.id} type="button" className="hub-row" onClick={() => onFocus(a.id)}>
            <Glyph signal={a.signal} size={8} />
            <span className="row-name">{a.name}</span>
            <span className="row-meta">{a.role} · {a.project?.id ?? "no project record"}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function InactivePanel({ inactive, now, total, onOpenProject }: { inactive: Agent[]; now: number; total: number; onOpenProject: (id: string) => void }) {
  const unlinked = inactive.filter((a) => !a.project).length;
  return (
    <>
      <header className="insp-head">
        <span className="hub-label">Collapsed</span>
        <div className="insp-title"><h2>Inactive agents</h2></div>
        <span className="insp-id">{inactive.length} of {total} idle, gone or without a running gateway</span>
      </header>
      <div className="insp-section">
        <span className="hub-label">Most recent first</span>
        {inactive.map((a) =>
          a.project ? (
            <button key={a.id} type="button" className="hub-row" onClick={() => onOpenProject(a.project!.id)}>
              <Glyph signal={a.signal} size={8} />
              <span className="row-name">{a.id}</span>
              <span className="row-meta">project {a.project.id} · {a.lastActiveAt ? formatDuration(sinceSeconds(a.lastActiveAt, now) ?? 0) : "never"}</span>
            </button>
          ) : (
            <div key={a.id} className="hub-row is-plain">
              <Glyph signal="unknown" size={8} />
              <span className="row-name">{a.id}</span>
              <span className="row-meta">no project record · {a.lastActiveAt ? formatDuration(sinceSeconds(a.lastActiveAt, now) ?? 0) : "never"}</span>
            </div>
          )
        )}
      </div>
      {unlinked ? <p className="hub-note">{unlinked} of these match no pjangler project by project_path or repo name.</p> : null}
    </>
  );
}

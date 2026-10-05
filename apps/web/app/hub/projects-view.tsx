"use client";

import { useMemo } from "react";
import { depPath, rectOf, useDrag, usePositions, type Pos, type Rect } from "./canvas";
import { Age, BandTrack, ComponentIcon, CopyRef, Glyph } from "./ui";
import type { Edge, Project, ProjectsPayload } from "./types";

type LaidNode = { id: string; x: number; y: number; w: number; h: number; p: Project; bus?: boolean };

const NW = 152;
const NH = 88;
const COL = NW + 40;
const ROW = NH + 48;
const FX = 48;
const ROW0 = 232;
// Stable homes for the known 33GOD components, so the map reads the same every visit.
const SLOTS: Record<string, [number, number]> = {
  momo: [0, 0], "pipeline-mcp-hub": [1, 0], flume: [2, 0], pjangler: [3, 0],
  krebs: [0, 1], candystore: [1, 1], holocene: [2, 1], "hermes-fleet": [3, 1]
};
const OUTSIDE_COL: Record<string, number> = { hindsight: 0, heyma: 1, skillex: 2.5 };

function layout(data: ProjectsPayload) {
  const nodes: LaidNode[] = [];
  const taken = new Set<string>();
  const components = data.projects.filter((p) => p.kind === "component");
  const bus = components.find((p) => p.id === "bloodbank");
  let maxRow = 1;
  const free: Array<[number, number]> = [];
  for (const p of components) {
    if (p === bus) continue;
    const slot = SLOTS[p.id];
    if (slot && !taken.has(slot.join())) {
      taken.add(slot.join());
      nodes.push({ id: p.id, x: FX + slot[0] * COL, y: ROW0 + slot[1] * ROW, w: NW, h: NH, p });
    } else free.push([0, 0]);
  }
  const unslotted = components.filter((p) => p !== bus && !nodes.some((n) => n.id === p.id)).sort((a, b) => a.name.localeCompare(b.name));
  let cell = 0;
  for (const p of unslotted) {
    while (taken.has([cell % 4, Math.floor(cell / 4)].join())) cell++;
    const c = cell % 4;
    const r = Math.floor(cell / 4);
    taken.add([c, r].join());
    maxRow = Math.max(maxRow, r);
    nodes.push({ id: p.id, x: FX + c * COL, y: ROW0 + r * ROW, w: NW, h: NH, p });
  }
  const busY = ROW0 + (maxRow + 1) * ROW;
  if (bus) nodes.push({ id: bus.id, x: FX, y: busY, w: 4 * COL - 40, h: 56, p: bus, bus: true });

  const outside = data.projects.filter((p) => p.kind === "outside");
  let spare = 0;
  for (const p of outside) {
    const col = OUTSIDE_COL[p.id] ?? 3.5 + spare++;
    nodes.push({ id: p.id, x: Math.round(FX + col * COL), y: 48, w: NW, h: NH, p });
  }
  const externals = data.projects.filter((p) => p.kind === "external");
  externals.forEach((p, i) => nodes.push({ id: p.id, x: FX + 4 * COL + 32, y: ROW0 + i * ROW, w: NW, h: 64, p }));

  const islands = data.projects
    .filter((p) => p.kind === "island")
    .sort((a, b) => Number(!!b.pm) - Number(!!a.pm) || a.name.localeCompare(b.name));
  const islandTop = busY + (bus ? 56 : 0) + 96;
  islands.forEach((p, i) => nodes.push({ id: p.id, x: 36 + (i % 9) * 112, y: islandTop + Math.floor(i / 9) * 56, w: 104, h: 48, p }));
  return { nodes, parent: data.projects.find((p) => p.kind === "parent"), islands };
}

export function ProjectsView({
  data,
  now,
  focus,
  onFocus,
  onOpenAgent
}: {
  data: ProjectsPayload;
  now: number;
  focus?: string;
  onFocus: (id: string) => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const { overrides, place, commit, reset } = usePositions("holocene.hub.projects.positions");
  const laid = useMemo(() => layout(data), [data]);
  const posOf = (n: LaidNode): Pos => overrides[n.id] ?? { x: n.x, y: n.y };
  const rects = new Map<string, Rect>(laid.nodes.map((n) => [n.id, rectOf(posOf(n), n.w, n.h)]));
  const byProjectId = new Map(data.projects.map((p) => [p.projectId ?? p.id, p.id]));
  const resolved = focus ? (data.projects.some((p) => p.id === focus) ? focus : byProjectId.get(focus)) : undefined;
  const sel = resolved ?? data.projects.find((p) => p.id === "holocene")?.id ?? laid.parent?.id ?? data.projects[0]?.id;
  const handlers = useDrag(place, commit, onFocus);

  const box = (kinds: Project["kind"][], padTop: number) => {
    const rs = laid.nodes.filter((n) => kinds.includes(n.p.kind)).map((n) => rects.get(n.id)!);
    if (!rs.length) return undefined;
    const l = Math.max(0, Math.min(...rs.map((r) => r.l)) - 24);
    const t = Math.max(0, Math.min(...rs.map((r) => r.t)) - padTop);
    return { l, t, w: Math.max(...rs.map((r) => r.r)) + 24 - l, h: Math.max(...rs.map((r) => r.b)) + 24 - t };
  };
  const frame = box(["component"], 56);
  const isles = box(["island"], 48);
  const hostW = Math.max(1072, ...[...rects.values()].map((r) => r.r + 48));
  const hostH = Math.max(712, ...[...rects.values()].map((r) => r.b + 48));

  const edges = data.edges
    .map((e) => {
      const a = rects.get(e.from);
      const b = rects.get(e.to);
      if (!a || !b) return undefined;
      return { e, hot: e.from === sel || e.to === sel, ...depPath(a, b) };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const selected = data.projects.find((p) => p.id === sel);

  return (
    <div className="hub-main">
      <section className="hub-canvas-panel" aria-label="Project canvas">
        <div className="hub-toolbar">
          <button type="button" className="hub-btn is-ghost" onClick={reset}>Reset layout</button>
        </div>
        <div className="hub-canvas">
          <div className="hub-host" style={{ width: hostW, height: hostH }}>
            {frame ? <div className="hub-frame" style={{ left: frame.l, top: frame.t, width: frame.w, height: frame.h }} aria-hidden="true" /> : null}
            {isles ? <div className="hub-frame is-islands" style={{ left: isles.l, top: isles.t, width: isles.w, height: isles.h }} aria-hidden="true" /> : null}
            <svg className="hub-edges" aria-hidden="true">
              {edges.map(({ e, hot, d, head }) => (
                <g key={`${e.from}>${e.to}`} className={`hub-dep${e.dashed ? " is-inferred" : ""}${hot ? " is-hot" : ""}`}>
                  <path d={d} className="dep-line" />
                  <path d={head} className="dep-head" />
                </g>
              ))}
            </svg>
            {frame && laid.parent ? (
              <button type="button" className="hub-frame-head" aria-pressed={sel === laid.parent.id} style={{ left: frame.l + 12, top: frame.t + 12 }} onClick={() => onFocus(laid.parent!.id)}>
                <span className="frame-name">{laid.parent.name}</span>
                <span className="frame-sub">{laid.parent.projectId ?? laid.parent.id}{laid.parent.board ? ` · board ${laid.parent.board}` : ""}</span>
                {laid.parent.pm ? (
                  <>
                    <Glyph signal={laid.parent.pm.signal} size={8} />
                    <span className="frame-sub">{laid.parent.pm.name}</span>
                  </>
                ) : null}
              </button>
            ) : null}
            {isles ? (
              <div className="hub-frame-head is-static" style={{ left: isles.l + 12, top: isles.t + 10 }}>
                <span className="frame-name">Standalone</span>
                <span className="frame-sub">{laid.islands.length} projects · {laid.islands.filter((p) => p.pm).length} with a PM</span>
              </div>
            ) : null}
            {laid.nodes.map((n) => {
              const pos = posOf(n);
              return (
                <button
                  key={n.id}
                  type="button"
                  className={`hub-node kind-${n.p.kind}${n.bus ? " is-bus" : ""}${n.p.registered || n.p.kind === "external" ? "" : " is-unregistered"}${n.p.pm?.signal === "you" ? " is-you" : ""}`}
                  aria-pressed={n.id === sel}
                  aria-label={`${n.p.name}${n.p.projectId ? `, project ${n.p.projectId}` : ""}${n.p.pm ? `, PM ${n.p.pm.id}` : ""}`}
                  style={{ left: pos.x, top: pos.y, width: n.w, height: n.h }}
                  {...handlers(n.id, pos)}
                >
                  <ProjectBody node={n} />
                </button>
              );
            })}
            {edges.filter((x) => x.hot).map(({ e, mx, my }) => (
              <span key={`label:${e.from}>${e.to}`} className="hub-edge-label" style={{ left: mx, top: my }}>{e.label}</span>
            ))}
          </div>
        </div>
        <footer className="hub-legend">
          <span className="hub-key"><i className="key-arrow" />Depends on, seen in code</span>
          <span className="hub-key"><i className="key-arrow is-inferred" />Disabled or documented only</span>
          <span className="hub-key"><ComponentIcon />Platform component</span>
          <span className="hub-last">Select a project to label its dependencies.</span>
        </footer>
      </section>
      <aside className="hub-inspector" aria-label="Selected project">
        {selected ? <ProjectPanel p={selected} data={data} now={now} onFocus={onFocus} onOpenAgent={onOpenAgent} /> : <p className="hub-note">Nothing selected.</p>}
      </aside>
    </div>
  );
}

function ProjectBody({ node }: { node: LaidNode }) {
  const p = node.p;
  const idLine =
    p.kind === "external" ? "external" :
    p.kind === "island" ? `${p.board ?? "no board"}${p.pm ? "" : " · no PM"}` :
    p.projectId ? `${p.projectId}${p.board ? ` · ${p.board}` : ""}${p.indexed ? "" : " · not indexed"}` :
    "not a pjangler project";
  if (p.kind === "island") {
    return (
      <>
        <span className="node-row">
          <Glyph signal={p.pm?.signal ?? "unknown"} size={8} />
          <span className="node-name is-small">{p.name}</span>
        </span>
        <span className="node-sub is-small">{idLine}</span>
      </>
    );
  }
  return (
    <>
      <span className="node-row">
        <span className="node-name">{p.name}</span>
        {p.kind !== "external" ? <ComponentIcon /> : null}
      </span>
      <span className={`node-sub${p.registered || p.kind === "external" ? "" : " is-warn"}`}>{idLine}</span>
      {p.kind !== "external" ? (
        <span className="node-row node-pm">
          {p.pm ? <Glyph signal={p.pm.signal} size={8} /> : null}
          <span className={p.pm?.signal === "you" ? "sig-text-you" : undefined}>{p.pm ? `${p.pm.id}${p.pm.signal === "you" ? " · needs you" : ""}` : p.registered ? "No PM" : ""}</span>
        </span>
      ) : null}
    </>
  );
}

function ProjectPanel({ p, data, now, onFocus, onOpenAgent }: { p: Project; data: ProjectsPayload; now: number; onFocus: (id: string) => void; onOpenAgent: (id: string) => void }) {
  const deps = data.edges.filter((e) => e.from === p.id);
  const users = data.edges.filter((e) => e.to === p.id);
  const name = (id: string) => data.projects.find((x) => x.id === id)?.name ?? id;
  const kindLabel = { parent: "Parent project", component: "Component of 33GOD", outside: "Platform component, outside the tree", island: "Standalone project", external: "External system" }[p.kind];
  const children = p.kind === "parent" ? data.projects.filter((x) => x.kind === "component" && x.registered) : [];
  void now;
  return (
    <>
      <header className="insp-head">
        <span className="hub-label">{kindLabel}</span>
        <div className="insp-title"><h2>{p.name}</h2></div>
        <span className="insp-id">
          {p.kind === "external" ? "not a pjangler project" : p.projectId ? `${p.projectId}${p.board ? ` · board ${p.board}` : " · no board bound"}${p.status ? ` · ${p.status}` : ""}` : "not a pjangler project"}
        </span>
        {p.what ? <p className="insp-what">{p.what}</p> : null}
      </header>
      {p.pm ? (
        <section className="hub-link-block" aria-label="Project manager">
          <div className="link-head">
            <span className="hub-label">{p.kind === "parent" ? "Director" : "Project manager"}</span>
            <span className="link-source">agents registry</span>
          </div>
          <div className="link-title">
            <Glyph signal={p.pm.signal} size={10} title={p.pm.state} />
            <button type="button" className="hub-textlink" onClick={() => onOpenAgent(p.pm!.id)}>{p.pm.name}</button>
            <span className="link-id">{p.pm.id}</span>
            <span className="link-status"><Age seconds={p.pm.heldSeconds} /></span>
          </div>
          <p className="link-basis">
            <Glyph signal={p.indexed ? "quiet" : "stuck"} size={8} />
            <span>
              {p.pm.basis === "project_path" ? "Matched on project_path." : p.pm.basis === "repo" ? "Matched on repo name only." : "Matched on the Plane board id."}
              {p.indexed ? "" : " Not in the pjangler index yet; read from .project.json."}
            </span>
          </p>
        </section>
      ) : p.kind !== "external" ? (
        <div className="hub-missing">
          <Glyph signal="unknown" size={8} />
          <span>{p.registered ? "No agent in the registry points at this project, by project_path or by repo name." : "Not a pjangler project, so no PM can attach to it."}</span>
        </div>
      ) : null}
      {p.repoPath ? (
        <dl className="insp-facts">
          <dt>Repo</dt>
          <dd><CopyRef value={p.repoPath} /></dd>
          {p.kind === "parent" ? (
            <>
              <dt>Children</dt>
              <dd>{children.length} registered: {children.map((c) => c.projectId ?? c.id).join(", ") || "none"}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {deps.length ? <DepList label="Depends on" edges={deps} pick={(e) => e.to} name={name} onFocus={onFocus} /> : null}
      {users.length ? <DepList label="Used by" edges={users} pick={(e) => e.from} name={name} onFocus={onFocus} /> : null}
      {p.tickets.length ? (
        <div className="insp-section">
          <span className="hub-label">Tickets in flight</span>
          {p.tickets.map((t) => (
            <div key={t.key} className="ticket-block">
              <div className="ticket-line">
                <CopyRef value={t.key} />
                <span>{t.title}</span>
              </div>
              <BandTrack ticket={t} />
              <span className="insp-meta">{[t.state, ...t.labels].filter(Boolean).join(" · ")}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function DepList({ label, edges, pick, name, onFocus }: { label: string; edges: Edge[]; pick: (e: Edge) => string; name: (id: string) => string; onFocus: (id: string) => void }) {
  return (
    <div className="insp-section">
      <span className="hub-label">{label}</span>
      {edges.map((e) => (
        <button key={`${e.from}>${e.to}`} type="button" className="hub-row is-dep" onClick={() => onFocus(pick(e))}>
          <span className="row-name">{name(pick(e))}</span>
          <span className="row-kind">{e.kind}</span>
          <span className="row-meta">{e.detail}</span>
        </button>
      ))}
    </div>
  );
}

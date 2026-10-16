"use client";

import type { WaxPipeline } from "./types";

// The compiled graph, drawn as a graph: nodes and edges come from the FROZEN
// pipeline definition (never re-derived from the live registry). Layout is a
// longest-path layering over the stored edges — deterministic, no physics.
//
// Edge kinds: `requires` (gated) renders solid with an arrowhead; `after`
// (continue, ordering only) renders dashed. Conditions and drift are drawn ON
// the nodes so the picture is the whole truth.

type Placed = { x: number; y: number; slug: string };

const NODE_W = 168;
const NODE_H = 56;
const COL_GAP = 96;
const ROW_GAP = 28;
const PAD = 24;

function layout(pipeline: WaxPipeline): { placed: Placed[]; rows: number; cols: number } {
  const nodes = pipeline.nodes ?? [];
  const edges = pipeline.edges ?? [];
  const level = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const slug of nodes.map((n) => n.slug)) incoming.set(slug, []);
  for (const edge of edges) {
    incoming.get(edge.to)?.push(edge.from);
  }
  // longest path to each node over both edge kinds (both order execution)
  const depth = (slug: string, seen: Set<string> = new Set()): number => {
    if (level.has(slug)) return level.get(slug) as number;
    if (seen.has(slug)) return 0; // defensive: catalog never shows cycles
    seen.add(slug);
    const parents = incoming.get(slug) ?? [];
    const d = parents.length ? Math.max(...parents.map((p) => depth(p, seen))) + 1 : 0;
    level.set(slug, d);
    return d;
  };
  for (const slug of nodes.map((n) => n.slug)) depth(slug);

  const byLevel = new Map<number, string[]>();
  let cols = 0;
  for (const node of nodes) {
    const d = level.get(node.slug) ?? 0;
    cols = Math.max(cols, d + 1);
    byLevel.set(d, [...(byLevel.get(d) ?? []), node.slug]);
  }
  let rows = 0;
  const placed: Placed[] = [];
  for (const [d, slugs] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    rows = Math.max(rows, slugs.length);
    slugs.forEach((slug, i) => {
      placed.push({ x: PAD + d * (NODE_W + COL_GAP), y: PAD + i * (NODE_H + ROW_GAP), slug });
    });
  }
  return { placed, rows, cols };
}

export function PipelineGraph({ pipeline }: { pipeline: WaxPipeline }) {
  const nodes = pipeline.nodes ?? [];
  const edges = pipeline.edges ?? [];
  if (!nodes.length) return null;
  const { placed, rows, cols } = layout(pipeline);
  const at = (slug: string) => placed.find((p) => p.slug === slug);
  const width = PAD * 2 + cols * NODE_W + (cols - 1) * COL_GAP;
  const height = PAD * 2 + rows * NODE_H + (rows - 1) * ROW_GAP;

  return (
    <div className="wax-graph-wrap">
      <svg
        className="wax-graph"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Graph of pipeline ${pipeline.name}: ${nodes.length} passes, ${edges.length} edges`}
      >
        <defs>
          <marker id="wax-arrow-gated" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" className="wax-arrow-gated" />
          </marker>
          <marker id="wax-arrow-continue" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" className="wax-arrow-continue" />
          </marker>
        </defs>
        {edges.map((edge, i) => {
          const from = at(edge.from);
          const to = at(edge.to);
          if (!from || !to) return null; // external after: recorded, not drawn
          const x1 = from.x + NODE_W;
          const y1 = from.y + NODE_H / 2;
          const x2 = to.x;
          const y2 = to.y + NODE_H / 2;
          const gated = edge.kind === "requires";
          const bend = (x1 + x2) / 2;
          const sameCol = x2 <= x1;
          const path = sameCol
            ? `M ${x1 - NODE_W / 2} ${y1 + NODE_H / 2} C ${x1 - NODE_W / 2} ${y1 + NODE_H + 20}, ${x2 - NODE_W / 2} ${y2 - NODE_H - 20}, ${x2 - NODE_W / 2} ${y2 + NODE_H / 4}`
            : `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}`;
          return (
            <path
              key={`${edge.from}-${edge.to}-${i}`}
              d={path}
              className={`wax-edge ${gated ? "is-gated" : "is-continue"}`}
              markerEnd={gated ? "url(#wax-arrow-gated)" : "url(#wax-arrow-continue)"}
            >
              <title>{`${edge.from} ${gated ? "gates" : "orders"} ${edge.to}${gated ? " (requires: a failure blocks)" : " (after: ordering only)"}`}</title>
            </path>
          );
        })}
        {nodes.map((node) => {
          const spot = at(node.slug);
          if (!spot) return null;
          const authored = node.name && node.name !== node.slug ? node.name : null;
          const hasWhen = node.conditions?.when != null;
          const hasSkip = node.conditions?.skip_when != null;
          const drift = node.registry_drift;
          return (
            <g key={node.slug} className={`wax-gnode${node.applicable === false ? " is-na" : ""}${drift ? " is-drifted" : ""}`}>
              <rect x={spot.x} y={spot.y} width={NODE_W} height={NODE_H} rx="8" className="wax-gnode-box" />
              <text x={spot.x + 12} y={spot.y + 21} className="wax-gnode-slug">{node.slug}</text>
              {authored ? (
                <text x={spot.x + 12} y={spot.y + 37} className="wax-gnode-name">“{authored}”</text>
              ) : (
                <text x={spot.x + 12} y={spot.y + 37} className="wax-gnode-name">
                  {node.applicable === false ? "n/a for documents" : `v${node.version ?? 1}`}
                </text>
              )}
              {hasWhen || hasSkip ? (
                <text x={spot.x + NODE_W - 12} y={spot.y + 21} className="wax-gnode-cond" textAnchor="end">
                  {hasWhen ? "when" : ""}{hasWhen && hasSkip ? "·" : ""}{hasSkip ? "skip" : ""}
                </text>
              ) : null}
              {drift ? (
                <circle cx={spot.x + NODE_W - 10} cy={spot.y + NODE_H - 10} r="5" className="wax-gnode-driftdot">
                  <title>{`registry moved on since compile (${drift.change}; frozen v${drift.frozen_version ?? "?"} → live v${drift.live_version ?? "?"}) — recompile to adopt`}</title>
                </circle>
              ) : null}
            </g>
          );
        })}
      </svg>
      <p className="wax-graph-legend">
        <span className="wax-legend-item"><span className="wax-legend-line is-gated" /> requires (gated)</span>
        <span className="wax-legend-item"><span className="wax-legend-line is-continue" /> after (continue)</span>
        <span className="wax-legend-item">● registry drift</span>
      </p>
    </div>
  );
}

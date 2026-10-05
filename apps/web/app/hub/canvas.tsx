"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

// The drag-and-drop canvas both views share: node positions default to a computed
// layout, a drag or arrow key overrides one, and overrides persist per view in
// localStorage so the operator's arrangement survives reloads.

export type Pos = { x: number; y: number };
export type Rect = { l: number; t: number; r: number; b: number; w: number; h: number; cx: number; cy: number };

export function rectOf(p: Pos, w: number, h: number): Rect {
  return { l: p.x, t: p.y, r: p.x + w, b: p.y + h, w, h, cx: Math.round(p.x + w / 2), cy: Math.round(p.y + h / 2) };
}

function readStored(key: string): Record<string, Pos> {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function usePositions(storageKey: string) {
  const [overrides, setOverrides] = useState<Record<string, Pos>>({});
  useEffect(() => setOverrides(readStored(storageKey)), [storageKey]);
  const persist = useCallback(
    (next: Record<string, Pos>) => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // storage blocked: positions still work for this visit
      }
    },
    [storageKey]
  );
  const place = useCallback(
    (id: string, x: number, y: number, save = false) => {
      setOverrides((prev) => {
        const next = { ...prev, [id]: { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) } };
        if (save) persist(next);
        return next;
      });
    },
    [persist]
  );
  const commit = useCallback(() => setOverrides((prev) => (persist(prev), prev)), [persist]);
  const reset = useCallback(() => {
    setOverrides({});
    persist({});
  }, [persist]);
  return { overrides, place, commit, reset };
}

type DragState = { id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean };

/** Pointer and keyboard handlers for one draggable node. A drag never fires the click. */
export function useDrag(place: (id: string, x: number, y: number, save?: boolean) => void, commit: () => void, select: (id: string) => void) {
  const drag = useRef<DragState | null>(null);
  const suppress = useRef(false);
  return useCallback(
    (id: string, pos: Pos) => ({
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        suppress.current = false;
        if (e.button !== 0) return;
        drag.current = { id, sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        const d = drag.current;
        if (!d || d.id !== id) return;
        const dx = e.clientX - d.sx;
        const dy = e.clientY - d.sy;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        d.moved = true;
        place(id, d.ox + dx, d.oy + dy);
      },
      onPointerUp: () => {
        const d = drag.current;
        drag.current = null;
        if (d?.moved) {
          suppress.current = true;
          setTimeout(() => (suppress.current = false), 0);
          commit();
        }
      },
      onPointerCancel: () => {
        drag.current = null;
      },
      onClick: () => {
        if (suppress.current) {
          suppress.current = false;
          return;
        }
        select(id);
      },
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
        const step = e.shiftKey ? 32 : 8;
        const m: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        const move = m[e.key];
        if (!move) return;
        e.preventDefault();
        place(id, pos.x + move[0], pos.y + move[1], true);
      }
    }),
    [place, commit, select]
  );
}

/** Org-chart line: down from the parent, along a bus, down into the child. */
export function treePath(a: Rect, b: Rect): string {
  const bus = a.b + 24;
  return `M ${a.cx} ${a.b} V ${bus} H ${b.cx} V ${b.t}`;
}

/** A contractor stacked under its PM: down the PM's left rail, then into the card. */
export function stackPath(a: Rect, b: Rect): string {
  return `M ${a.l + 14} ${a.b} V ${b.cy} H ${b.l}`;
}

/** Dependency edge: straight where the boxes overlap, otherwise a curve between facing sides. */
export function depPath(S: Rect, T: Rect): { d: string; head: string; mx: number; my: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  let g: { x1: number; y1: number; x2: number; y2: number; curve?: "v" | "h" };
  const ox = Math.min(S.r, T.r) - Math.max(S.l, T.l);
  const oy = Math.min(S.b, T.b) - Math.max(S.t, T.t);
  const x = Math.round((Math.max(S.l, T.l) + Math.min(S.r, T.r)) / 2);
  const y = Math.round((Math.max(S.t, T.t) + Math.min(S.b, T.b)) / 2);
  if (ox > 24 && T.t >= S.b) g = { x1: x, y1: S.b, x2: x, y2: T.t };
  else if (ox > 24 && S.t >= T.b) g = { x1: x, y1: S.t, x2: x, y2: T.b };
  else if (oy > 24 && T.l >= S.r) g = { x1: S.r, y1: y, x2: T.l, y2: y };
  else if (oy > 24 && S.l >= T.r) g = { x1: S.l, y1: y, x2: T.r, y2: y };
  else {
    const dx = T.cx - S.cx;
    const dy = T.cy - S.cy;
    if (Math.abs(dy) >= Math.abs(dx) * 0.6) {
      const sx = clamp(T.cx, S.l + 16, S.r - 16);
      const tx = clamp(S.cx, T.l + 16, T.r - 16);
      g = dy > 0 ? { x1: sx, y1: S.b, x2: tx, y2: T.t, curve: "v" } : { x1: sx, y1: S.t, x2: tx, y2: T.b, curve: "v" };
    } else {
      const sy = clamp(T.cy, S.t + 12, S.b - 12);
      const ty = clamp(S.cy, T.t + 12, T.b - 12);
      g = dx > 0 ? { x1: S.r, y1: sy, x2: T.l, y2: ty, curve: "h" } : { x1: S.l, y1: sy, x2: T.r, y2: ty, curve: "h" };
    }
  }
  let d: string;
  let ux: number;
  let uy: number;
  if (g.curve === "v") {
    const my = (g.y1 + g.y2) / 2;
    d = `M ${g.x1} ${g.y1} C ${g.x1} ${my} ${g.x2} ${my} ${g.x2} ${g.y2}`;
    ux = 0;
    uy = g.y2 > g.y1 ? 1 : -1;
  } else if (g.curve === "h") {
    const mx = (g.x1 + g.x2) / 2;
    d = `M ${g.x1} ${g.y1} C ${mx} ${g.y1} ${mx} ${g.y2} ${g.x2} ${g.y2}`;
    ux = g.x2 > g.x1 ? 1 : -1;
    uy = 0;
  } else {
    const len = Math.max(1, Math.hypot(g.x2 - g.x1, g.y2 - g.y1));
    ux = (g.x2 - g.x1) / len;
    uy = (g.y2 - g.y1) / len;
    d = `M ${g.x1} ${g.y1} L ${g.x2} ${g.y2}`;
  }
  const bx = g.x2 - ux * 7;
  const by = g.y2 - uy * 7;
  const head = `M ${g.x2} ${g.y2} L ${(bx - uy * 3.5).toFixed(1)} ${(by + ux * 3.5).toFixed(1)} L ${(bx + uy * 3.5).toFixed(1)} ${(by - ux * 3.5).toFixed(1)} Z`;
  return { d, head, mx: Math.round((g.x1 + g.x2) / 2), my: Math.round((g.y1 + g.y2) / 2) };
}

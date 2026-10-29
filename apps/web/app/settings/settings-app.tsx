"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Brand, ThemeToggle, usePoll, useTheme } from "../hub/hub-app";
import { formatDuration, HubTabs, sinceSeconds } from "../hub/ui";

// Holocene settings. First setting: agent avatars. One avatar per agent, stored by the Holocene API
// (apps/api/src/avatars.ts) and mirrored both ways with each agent's gateways (Telegram today): upload one here
// and it goes to the bot; change the bot's photo and it comes back here; an agent with none takes its bot's.
// The Agent Pad and the hub canvas read the same copy.

type GatewayStatus = {
  kind: "telegram";
  connected: boolean;
  bot?: string;
  state: "in_sync" | "pending" | "no_photo" | "read_only" | "error" | "not_configured";
  detail?: string;
  syncedAt?: string;
};
type AvatarRow = { id: string; name: string; avatar: string | null; source: "holocene" | "telegram" | null; updatedAt?: string; gateways: GatewayStatus[] };

const OUT = 1024; // uploaded avatars are square JPEGs at this size
const VIEW = 240; // the editor's preview square

const SOURCE_WORD = { holocene: "Set in Holocene", telegram: "From Telegram" } as const;

function gatewayText(g: GatewayStatus, now: number): string {
  const bot = g.bot ? `@${g.bot}` : "Telegram";
  const ago = g.syncedAt ? ` · ${formatDuration(sinceSeconds(g.syncedAt, now) ?? 0)} ago` : "";
  switch (g.state) {
    case "in_sync": return `${bot} · in sync${ago}`;
    case "pending": return `${bot} · sending…`;
    case "no_photo": return `${bot} · the bot has no photo yet`;
    case "read_only": return `${bot} · read-only (no token in the profile)`;
    case "not_configured": return "No Telegram bot";
    default: return `${bot} · ${g.detail ?? "error"}`;
  }
}

/** Square crop with zoom and drag, rendered to a 1024px JPEG. The circle shows what Telegram and the pad keep. */
function AvatarEditor({ file, onCancel, onSave, saving }: { file: File; onCancel: () => void; onSave: (jpeg: Blob) => void; saving: boolean }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 }); // pan, in preview px, from centred
  const [error, setError] = useState<string>();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    setError(undefined);
    setImg(null);
    const url = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => { setImg(i); setZoom(1); setOff({ x: 0, y: 0 }); };
    i.onerror = () => setError("That file is not an image this browser can read.");
    i.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // How far the picture can be panned (preview px) before the crop would leave it: zoom shrinks the crop square, the
  // long side of a non-square picture leaves room too.
  const limits = useCallback((im: HTMLImageElement, z: number) => {
    const side = Math.min(im.naturalWidth, im.naturalHeight) / z;
    const scale = side / VIEW;
    return { x: (im.naturalWidth - side) / 2 / scale, y: (im.naturalHeight - side) / 2 / scale };
  }, []);
  const clampOff = useCallback((o: { x: number; y: number }, z: number) => {
    if (!img) return o;
    const l = limits(img, z);
    return { x: Math.max(-l.x, Math.min(l.x, o.x)), y: Math.max(-l.y, Math.min(l.y, o.y)) };
  }, [img, limits]);
  useEffect(() => setOff((o) => clampOff(o, zoom)), [zoom, clampOff]);

  // Source rectangle for the current zoom and pan, clamped so the crop never leaves the image.
  const crop = useCallback((im: HTMLImageElement) => {
    const side = Math.min(im.naturalWidth, im.naturalHeight) / zoom;
    const scale = side / VIEW; // source px per preview px
    const maxX = (im.naturalWidth - side) / 2;
    const maxY = (im.naturalHeight - side) / 2;
    const cx = Math.max(-maxX, Math.min(maxX, -off.x * scale));
    const cy = Math.max(-maxY, Math.min(maxY, -off.y * scale));
    return { sx: (im.naturalWidth - side) / 2 + cx, sy: (im.naturalHeight - side) / 2 + cy, side };
  }, [zoom, off]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    const ctx = c.getContext("2d")!;
    const { sx, sy, side } = crop(img);
    ctx.fillStyle = "#ffffff"; // the same ground the saved JPEG gets, so transparent pictures preview truthfully
    ctx.fillRect(0, 0, VIEW, VIEW);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, VIEW, VIEW);
  }, [img, crop]);

  const onDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d) setOff(clampOff({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }, zoom));
  };
  const onKey = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 40 : 8;
    const move: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const m = move[e.key];
    if (!m) return;
    e.preventDefault();
    setOff((o) => clampOff({ x: o.x + m[0], y: o.y + m[1] }, zoom));
  };

  const save = () => {
    if (!img) return;
    const out = document.createElement("canvas");
    out.width = out.height = OUT;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#ffffff"; // transparent PNGs get a white ground, not black
    ctx.fillRect(0, 0, OUT, OUT);
    const { sx, sy, side } = crop(img);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, side, side, 0, 0, OUT, OUT);
    out.toBlob((b) => (b ? onSave(b) : setError("Could not encode the image.")), "image/jpeg", 0.9);
  };

  return (
    <div className="set-editor">
      {error ? <p className="hub-error" role="alert">{error}</p> : null}
      <div className="set-crop" style={{ width: VIEW, height: VIEW }}>
        <canvas
          ref={canvas}
          width={VIEW}
          height={VIEW}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
          onKeyDown={onKey}
          tabIndex={0}
          role="img"
          aria-label="Avatar crop preview. Drag, or use the arrow keys, to position it."
        />
        <span className="set-crop-ring" aria-hidden="true" />
      </div>
      <div className="set-editor-side">
        <label className="set-zoom">
          <span className="hub-label">Zoom</span>
          <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
        <p className="hub-note">Drag or use the arrow keys to position. The circle is what Telegram and the Agent Pad show.</p>
        <div className="set-actions">
          <button type="button" className="hub-btn" onClick={save} disabled={!img || saving}>{saving ? "Saving…" : "Save and send"}</button>
          <button type="button" className="hub-btn is-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function AgentAvatarRow({ row, now, focused, onChanged }: { row: AvatarRow; now: number; focused: boolean; onChanged: (r: AvatarRow) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"save" | "pull" | null>(null);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement | null>(null);
  const el = useRef<HTMLLIElement | null>(null);
  const tg = row.gateways.find((g) => g.kind === "telegram");

  useEffect(() => {
    if (focused) el.current?.scrollIntoView({ block: "center" });
  }, [focused]);

  const send = async (path: string, init: RequestInit, kind: "save" | "pull") => {
    setBusy(kind);
    setError(undefined);
    try {
      const res = await fetch(path, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      onChanged(body as AvatarRow);
      setFile(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <li ref={el} className={`set-row${focused ? " is-focused" : ""}`}>
      <div className="set-row-main">
        <span className={`set-avatar${row.avatar ? "" : " is-empty"}`}>
          {row.avatar ? <img src={row.avatar} alt="" /> : row.name.charAt(0)}
        </span>
        <div className="set-who">
          <span className="set-name">{row.name}</span>
          <span className="set-id">{row.id}</span>
        </div>
        <div className="set-state">
          <span className={`set-chip is-${row.source ?? "none"}`}>{row.source ? SOURCE_WORD[row.source] : "No avatar"}</span>
          {tg ? <span className={`set-gw is-${tg.state}`} title={tg.detail}>{gatewayText(tg, now)}</span> : null}
        </div>
        <div className="set-actions">
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = ""; }}
          />
          <button type="button" className="hub-btn" onClick={() => input.current?.click()} disabled={!!busy} aria-label={`Upload an avatar for ${row.name}`}>Upload…</button>
          <button
            type="button"
            className="hub-btn is-ghost"
            disabled={!!busy || !tg || tg.state === "not_configured"}
            title="Replace Holocene's copy with the bot's current photo"
            aria-label={`Pull ${row.name}'s avatar from Telegram`}
            onClick={() => void send(`/api/modules/avatars/${row.id}/pull`, { method: "POST" }, "pull")}
          >
            {busy === "pull" ? "Pulling…" : "Pull from Telegram"}
          </button>
        </div>
      </div>
      {error ? <p className="hub-error set-row-error" role="alert">{error}</p> : null}
      {file ? (
        <AvatarEditor
          file={file}
          saving={busy === "save"}
          onCancel={() => setFile(null)}
          onSave={(jpeg) => void send(`/api/modules/avatars/${row.id}`, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: jpeg }, "save")}
        />
      ) : null}
    </li>
  );
}

export function SettingsApp() {
  const [theme, toggleTheme] = useTheme();
  const list = usePoll<{ agents: AvatarRow[] }>("/api/modules/avatars", 15_000);
  const [local, setLocal] = useState<Record<string, AvatarRow>>({});
  const [q, setQ] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [focus, setFocus] = useState<string>();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    setFocus(new URLSearchParams(location.search).get("agent") ?? undefined);
    return () => clearInterval(t);
  }, []);
  // A fresh poll supersedes what a save returned.
  useEffect(() => setLocal({}), [list.data]);

  const rows = useMemo(() => {
    const all = (list.data?.agents ?? []).map((r) => local[r.id] ?? r);
    const needle = q.trim().toLowerCase();
    return all
      .filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.id.includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [list.data, local, q]);
  const withAvatar = (list.data?.agents ?? []).filter((r) => (local[r.id] ?? r).avatar).length;

  return (
    <div className="hub-root" data-theme={theme}>
      <header className="hub-header">
        <Brand />
        <HubTabs current="settings" />
        <div className="hub-header-end">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="hub-body set-body">
        <div className="hub-lede">
          <p className="hub-statement" aria-live="polite">
            {list.data ? `${withAvatar} of ${list.data.agents.length} agents have an avatar.` : list.error ? "The Holocene API is not answering." : "Reading the agents…"}
          </p>
        </div>

        <section className="set-section" aria-labelledby="set-avatars">
          <header className="set-section-head">
            <h2 id="set-avatars">Agent avatars</h2>
            <p className="hub-note">
              One picture per agent, shown in Telegram, on the Agent Pad and here. Upload one and it is sent to the agent's
              Telegram bot. Change the bot's photo in Telegram and it comes back here within ten minutes. An agent with no
              avatar takes its bot's.
            </p>
            <input className="set-search" type="search" placeholder="Filter agents" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter agents" />
          </header>
          {list.error && !list.data ? <p className="hub-error" role="status">GET /api/modules/avatars failed: {list.error}</p> : null}
          <ul className="set-list">
            {rows.map((r) => (
              <AgentAvatarRow key={r.id} row={r} now={now} focused={focus === r.id} onChanged={(next) => setLocal((m) => ({ ...m, [next.id]: next }))} />
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

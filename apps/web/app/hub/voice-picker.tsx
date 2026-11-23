"use client";

import { useEffect, useRef, useState } from "react";
import { Glyph } from "./ui";
import type { Agent } from "./types";

// The voice an agent speaks, picked from the Vox catalog. Flume owns the assignment (`flume identity voice`);
// this control reads and writes it only through /api/modules/hub/agents/:id/voice, which runs that command.

type VoiceOption = { name: string; displayName: string; tags: string[]; persona?: string };
type AgentVoice = {
  ok: boolean;
  agentId: string;
  voice: string | null;
  source: "pinned" | "fleet default" | "none";
  fleetDefault: string | null;
  blockers: Array<{ code: string; detail: string }>;
  detail: string;
  gateway?: { action: string; confirmed: boolean; detail: string };
};

const INHERIT = "";

// One catalog fetch shared by every panel the operator clicks through.
let catalogPromise: Promise<VoiceOption[]> | undefined;
function loadCatalog(): Promise<VoiceOption[]> {
  catalogPromise ??= fetch("/api/modules/hub/voices", { cache: "no-store" })
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      return (body.voices ?? []) as VoiceOption[];
    })
    .catch((err) => {
      catalogPromise = undefined; // let the next panel retry
      throw err;
    });
  return catalogPromise;
}

async function voiceCall(agentId: string, init?: RequestInit): Promise<AgentVoice> {
  const res = await fetch(`/api/modules/hub/agents/${encodeURIComponent(agentId)}/voice`, { cache: "no-store", ...init });
  const body = await res.json().catch(() => ({}));
  if (body && typeof body === "object" && "agentId" in body) return body as AgentVoice;
  throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
}

export function VoicePicker({ agent }: { agent: Agent }) {
  const [catalog, setCatalog] = useState<VoiceOption[]>();
  const [catalogError, setCatalogError] = useState<string>();
  const [current, setCurrent] = useState<AgentVoice>();
  const [readError, setReadError] = useState<string>();
  const [saving, setSaving] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: "ok" | "warn" | "error"; text: string }>();
  // Responses for an agent the operator has already clicked away from are dropped.
  const live = useRef(agent.id);

  useEffect(() => {
    let on = true;
    loadCatalog().then(
      (v) => on && (setCatalog(v), setCatalogError(undefined)),
      (e) => on && setCatalogError(e instanceof Error ? e.message : String(e))
    );
    return () => {
      on = false;
    };
  }, []);

  useEffect(() => {
    live.current = agent.id;
    setCurrent(undefined);
    setReadError(undefined);
    setResult(undefined);
    setSaving(null);
    voiceCall(agent.id).then(
      (v) => live.current === agent.id && setCurrent(v),
      (e) => live.current === agent.id && setReadError(e instanceof Error ? e.message : String(e))
    );
  }, [agent.id]);

  const pinned = current?.source === "pinned" ? current.voice : null;
  const value = saving ?? (pinned ?? INHERIT);
  const refused = current && !current.ok ? current.blockers : [];
  const disabled = !current || !current.ok || saving !== null || !catalog;
  const known = new Set((catalog ?? []).map((v) => v.name));

  const choose = async (next: string) => {
    if (next === value) return;
    const id = agent.id;
    setSaving(next);
    setResult(undefined);
    try {
      const v = await voiceCall(id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: next === INHERIT ? null : next })
      });
      if (live.current !== id) return;
      if (v.ok) {
        setCurrent(v);
        const picked = v.gateway?.confirmed !== false;
        setResult({ tone: picked ? "ok" : "warn", text: `${v.detail}.${v.gateway ? ` ${v.gateway.detail}` : ""}` });
      } else {
        setResult({ tone: "error", text: v.blockers.map((b) => b.detail).join("; ") || v.detail || "Flume refused the change." });
        voiceCall(id).then((r) => live.current === id && setCurrent(r), () => undefined);
      }
    } catch (e) {
      if (live.current === id) setResult({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      if (live.current === id) setSaving(null);
    }
  };

  const label = (v: VoiceOption) => (v.displayName.toLowerCase() === v.name ? v.displayName : `${v.displayName} · ${v.name}`);

  return (
    <div className="insp-section hub-voice">
      <label className="hub-label" htmlFor={`voice-${agent.id}`}>Voice</label>
      <div className="voice-row">
        <select
          id={`voice-${agent.id}`}
          className="hub-select"
          value={value}
          disabled={disabled}
          aria-busy={saving !== null || !current}
          onChange={(e) => void choose(e.target.value)}
        >
          <option value={INHERIT}>{`Fleet default${current?.fleetDefault ? ` (${current.fleetDefault})` : ""}`}</option>
          {pinned && !known.has(pinned) ? <option value={pinned}>{`${pinned} · not in Vox`}</option> : null}
          {(catalog ?? []).map((v) => (
            <option key={v.name} value={v.name}>{label(v)}</option>
          ))}
        </select>
        {saving !== null ? <span className="voice-status">Saving…</span> : null}
      </div>
      <span className="insp-meta">
        {readError
          ? `Could not read the voice: ${readError}`
          : !current
            ? "Asking Flume…"
            : current.ok
              ? `Speaks ${current.voice ?? "nothing"} · ${current.source === "pinned" ? "pinned on its desk" : "inherits the fleet default"}`
              : "Flume cannot assign a voice to this agent."}
      </span>
      {refused.length ? (
        <p className="voice-msg tone-error">
          <Glyph signal="unknown" size={8} />
          <span>{refused.map((b) => b.detail).join("; ")}</span>
        </p>
      ) : null}
      {catalogError ? <p className="voice-msg tone-error"><Glyph signal="broken" size={8} /><span>Vox catalog unavailable: {catalogError}</span></p> : null}
      {result ? (
        <p className={`voice-msg tone-${result.tone}`} role="status">
          <Glyph signal={result.tone === "ok" ? "cleared" : result.tone === "warn" ? "stuck" : "broken"} size={8} />
          <span>{result.text}</span>
        </p>
      ) : null}
      <span className="hub-note">Assigned in Flume (<code>flume identity voice</code>); Holocene, Telegram and the car only render it.</span>
    </div>
  );
}

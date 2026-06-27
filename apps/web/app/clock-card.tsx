"use client";

import { useCallback, useEffect, useState } from "react";

type ClockStatus = "idle" | "loading" | "success" | "error";

type ClockState = {
  state: string;
  updatedAt: string;
};

type ClockResponse = {
  success: boolean;
  action?: string;
  state?: string;
  error?: string;
};

const STORAGE_KEY = "holocene-clock-state";
const RESULT_DISPLAY_MS = 3000;

function loadCachedState(): ClockState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClockState;
    if (typeof parsed.state === "string" && typeof parsed.updatedAt === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

function saveCachedState(state: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state, updatedAt: new Date().toISOString() })
    );
  } catch {
    // ignore storage errors
  }
}

export function ClockCard({ apiBase }: { apiBase: string }) {
  const [status, setStatus] = useState<ClockStatus>("idle");
  const [message, setMessage] = useState<string>("");
  const [cachedState, setCachedState] = useState<ClockState | null>(loadCachedState);

  useEffect(() => {
    setCachedState(loadCachedState);
  }, []);

  const invoke = useCallback(
    async (action: "in" | "out") => {
      if (status === "loading") return;
      setStatus("loading");
      setMessage("");

      try {
        const res = await fetch(`${apiBase}/api/clock/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          cache: "no-store"
        });

        const body = (await res.json().catch(() => ({}))) as ClockResponse;

        if (!res.ok || !body.success) {
          throw new Error(body.error ?? `Clock ${action} failed (${res.status})`);
        }

        const newState = body.state ?? "unknown";
        saveCachedState(newState);
        setCachedState({ state: newState, updatedAt: new Date().toISOString() });
        setStatus("success");
        setMessage(newState);
      } catch (err) {
        setStatus("error");
        setMessage(err instanceof Error ? err.message : "Unexpected error");
      }

      window.setTimeout(() => {
        setStatus((current) => (current === "success" || current === "error" ? "idle" : current));
      }, RESULT_DISPLAY_MS);
    },
    [apiBase, status]
  );

  const stateLabel = cachedState
    ? `Last state: ${cachedState.state} · ${new Date(cachedState.updatedAt).toLocaleTimeString()}`
    : "Last state: unknown";

  return (
    <section className="clock-card" aria-label="Clock in / out">
      <div className="clock-card-header">
        <h2>Orwell</h2>
        <p className="section-note">Manual clock-in / clock-out control.</p>
      </div>
      <div className="clock-card-actions">
        <button
          className="clock-btn clock-btn-in"
          disabled={status === "loading"}
          onClick={() => void invoke("in")}
          type="button"
        >
          Clock In
        </button>
        <button
          className="clock-btn clock-btn-out"
          disabled={status === "loading"}
          onClick={() => void invoke("out")}
          type="button"
        >
          Clock Out
        </button>
      </div>
      <div className="clock-card-status" aria-live="polite">
        {status === "idle" ? <span>{stateLabel}</span> : null}
        {status === "loading" ? <span className="clock-spinner" aria-label="Loading" /> : null}
        {status === "success" ? (
          <span className="clock-status clock-status-success">
            <span aria-hidden>✓</span> {message}
          </span>
        ) : null}
        {status === "error" ? (
          <span className="clock-status clock-status-error">
            <span aria-hidden>✕</span> {message}
          </span>
        ) : null}
      </div>
    </section>
  );
}

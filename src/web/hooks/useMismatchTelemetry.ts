/**
 * useMismatchTelemetry — emits holocene.agent_view.mismatch events
 * to Bloodbank when an agent is active (recent events) but has no
 * started Plane ticket assigned.
 *
 * Debounced: emits at most once per agent per 5 minutes.
 */

import { useEffect, useRef } from 'react';

type MismatchEntry = {
  agentId: string;
  agentName: string;
  lastEventTime: string;
  eventCount: number;
};

const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

// POST to Bloodbank /publish endpoint (through nginx proxy)
async function emitMismatch(entry: MismatchEntry): Promise<void> {
  try {
    await fetch('/api/bloodbank/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'holocene.agent_view.mismatch',
        payload: {
          agent_id: entry.agentId,
          agent_name: entry.agentName,
          last_event_time: entry.lastEventTime,
          event_count: entry.eventCount,
          reason: 'Agent has recent Bloodbank events but no started Plane ticket',
          detected_by: 'holocene-agent-graph',
          detected_at: new Date().toISOString(),
        },
      }),
    });
  } catch {
    // Telemetry is best-effort — don't break the UI
  }
}

export function useMismatchTelemetry(mismatches: MismatchEntry[]) {
  const lastEmitted = useRef<Record<string, number>>({});

  useEffect(() => {
    const now = Date.now();

    for (const m of mismatches) {
      const lastTime = lastEmitted.current[m.agentId] ?? 0;
      if (now - lastTime < DEBOUNCE_MS) continue;

      lastEmitted.current[m.agentId] = now;
      emitMismatch(m);
    }
  }, [mismatches]);
}

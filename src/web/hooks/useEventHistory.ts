/**
 * useEventHistory — Fetch persisted events from Candystore on mount.
 *
 * Hits GET /api/events?limit=N and returns them in the same BloodbankEvent
 * shape that useBloodbankStream produces, so EventsPanel can merge both.
 */
import { useEffect, useState, useCallback } from 'react';
import type { BloodbankEvent } from './useBloodbankStream';

export type EventHistoryOptions = {
  /** Max events to fetch on load. Default 50. */
  limit?: number;
  /** Event type filter (e.g. "agent.grolf.status"). */
  eventType?: string;
};

/**
 * Convert a Candystore EventEnvelope row into the BloodbankEvent shape
 * that the WS relay + EventsPanel already understand.
 */
function toBloodbankEvent(row: Record<string, unknown>): BloodbankEvent {
  const eventType =
    typeof row.event_type === 'string' ? row.event_type : 'unknown';

  return {
    type: 'event',
    routing_key: eventType,
    envelope: {
      event_id:
        typeof row.event_id === 'string'
          ? row.event_id
          : (globalThis.crypto?.randomUUID?.() ?? `hist-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
      event_type: eventType,
      timestamp:
        typeof row.timestamp === 'string'
          ? row.timestamp
          : new Date().toISOString(),
      payload:
        row.payload && typeof row.payload === 'object'
          ? (row.payload as Record<string, unknown>)
          : {},
      // Pass through extra fields the panel might use
      ...(row.source ? { source: row.source } : {}),
      ...(row.version ? { version: row.version } : {}),
    },
  };
}

export function useEventHistory(opts: EventHistoryOptions = {}) {
  const { limit = 50, eventType } = opts;
  const [events, setEvents] = useState<BloodbankEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      if (eventType) params.set('event_type', eventType);

      const res = await fetch(`/api/events?${params.toString()}`);

      if (!res.ok) {
        // Candystore might not be running yet — degrade gracefully
        if (res.status === 502 || res.status === 503) {
          setEvents([]);
          return;
        }
        throw new Error(`Event history fetch failed: ${res.status}`);
      }

      const json = await res.json();
      const rows: Record<string, unknown>[] = Array.isArray(json) ? json : [];
      setEvents(rows.map(toBloodbankEvent));
    } catch (err) {
      // Network errors (Candystore down) → empty list, no crash
      console.warn('[useEventHistory] fetch failed, degrading:', err);
      setError(err instanceof Error ? err.message : String(err));
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [limit, eventType]);

  useEffect(() => {
    fetchEvents();

    // Keep retrying history fetch so transient 502/503 doesn't leave UI empty forever.
    const timer = setInterval(() => {
      fetchEvents();
    }, 10000);

    return () => clearInterval(timer);
  }, [fetchEvents]);

  return { events, loading, error, refetch: fetchEvents };
}

import { useEffect, useRef, useState, useCallback } from 'react';

export type BloodbankEvent = {
  type: 'event' | 'ping';
  routing_key?: string;
  envelope?: {
    event_id: string;
    event_type: string;
    timestamp: string;
    payload: Record<string, unknown>;
  };
};

const WS_URL = import.meta.env.VITE_BLOODBANK_WS_URL ?? '/ws/events';

export function useBloodbankStream(url = WS_URL) {
  const [events, setEvents] = useState<BloodbankEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    try {
      // Build absolute URL if relative
      const absUrl = url.startsWith('ws') ? url : `ws://${window.location.host}${url}`;
      const ws = new WebSocket(absUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (mountedRef.current) setConnected(true);
      };

      ws.onclose = () => {
        if (mountedRef.current) {
          setConnected(false);
          reconnectTimer.current = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (e) => {
        try {
          const data: BloodbankEvent = JSON.parse(e.data);
          if (data.type === 'event' && mountedRef.current) {
            setEvents((prev) => [data, ...prev].slice(0, 100));
          }
        } catch {
          // ignore malformed messages
        }
      };
    } catch {
      // connection failed, retry
      if (mountedRef.current) {
        reconnectTimer.current = setTimeout(connect, 3000);
      }
    }
  }, [url]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, connected, clearEvents };
}

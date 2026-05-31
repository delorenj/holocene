import { useEffect, useRef, useState, useCallback } from 'react';
import {
  BLOODBANK_STREAM_WS_URL,
  BLOODBANK_STREAM_WS_FALLBACK,
} from '../config/stream';

export type BloodbankEvent = {
  type: 'event' | 'ping' | 'welcome';
  routing_key?: string;
  envelope?: {
    event_id: string;
    event_type: string;
    timestamp: string;
    payload: Record<string, unknown>;
  };
};

const WS_URL = BLOODBANK_STREAM_WS_URL;

export function useBloodbankStream(url = WS_URL) {
  const [events, setEvents] = useState<BloodbankEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const attemptRef = useRef(0);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    try {
      const targetUrl = attemptRef.current % 2 === 0 ? url : BLOODBANK_STREAM_WS_FALLBACK;

      // Build absolute URL if relative, respecting TLS
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const absUrl = targetUrl.startsWith('ws')
        ? targetUrl
        : `${protocol}//${window.location.host}${targetUrl}`;

      const ws = new WebSocket(absUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (mountedRef.current) {
          setConnected(true);
          attemptRef.current = 0;
        }
      };

      ws.onclose = () => {
        if (mountedRef.current) {
          setConnected(false);
          attemptRef.current += 1;
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
        attemptRef.current += 1;
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

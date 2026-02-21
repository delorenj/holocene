export const RELAY_WS_ENDPOINT = 'ws://bloodbank-ws-relay:8683';

/**
 * Shared stream endpoint config for real-time Bloodbank events.
 *
 * Priority:
 * 1) VITE_BLOODBANK_WS_URL (explicit override)
 * 2) Internal relay endpoint (docker network)
 */
export const BLOODBANK_STREAM_WS_URL =
  import.meta.env.VITE_BLOODBANK_WS_URL ?? RELAY_WS_ENDPOINT;

/**
 * Browser-safe fallback through Holocene reverse proxy.
 */
export const BLOODBANK_STREAM_WS_FALLBACK =
  import.meta.env.VITE_BLOODBANK_WS_FALLBACK_URL ?? '/ws';

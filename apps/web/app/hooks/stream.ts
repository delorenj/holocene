import type { HookHistory, HookSnapshot } from "./model";

export type HookConnection = "connecting" | "live" | "reconnecting" | "offline";

export function hookFeedLabel({ paused, browsingHistory, connection, error, collection, hubIssue }: {
  paused: boolean;
  browsingHistory: boolean;
  connection: HookConnection;
  error: boolean;
  collection?: HookSnapshot["collection"];
  hubIssue: boolean;
}) {
  if (paused) return "Paused";
  if (browsingHistory) return "Browsing history";
  if (connection === "reconnecting") return "Reconnecting";
  if (connection === "connecting") return "Connecting";
  if (connection === "offline") return "Feed unavailable";
  if (error) return "Updates interrupted";
  if (collection?.state === "reconnecting") return "Reconnecting";
  if (collection?.state === "connecting" || collection?.state === "starting") return "Connecting";
  if (collection?.state === "error" || collection?.state === "stopped") return "Feed unavailable";
  if (collection?.catching_up) return "Catching up";
  if (collection?.hook_snapshot_state === "waiting") return "Waiting for events";
  if (collection?.hook_snapshot_state === "stale") return "Live · overview stale";
  return hubIssue ? "Hub needs attention" : "Live";
}

export type HookFilters = {
  cli?: string;
  native?: string;
  role?: string;
  handler?: string;
  status?: string;
  limit: number;
  offset: number;
};

export function hookQuery(filters: HookFilters) {
  const query = new URLSearchParams({ limit: String(filters.limit), offset: String(filters.offset) });
  for (const key of ["cli", "native", "role", "handler", "status"] as const) {
    if (filters[key]) query.set(key, filters[key]);
  }
  return query.toString();
}

type Source = Pick<EventSource, "addEventListener" | "removeEventListener" | "close" | "readyState">;

type HookStreamOptions = {
  query: string;
  once?: boolean;
  onSnapshot: (snapshot: HookSnapshot) => void;
  onHistory: (history: HookHistory) => void;
  onConnection: (connection: HookConnection) => void;
  onError: (message: string) => void;
  createSource?: (url: string) => Source;
};

// The API projects each committed collection update. Replace the current page
// atomically so a changed outcome can remove a row from an active filter.
export function subscribeToHooks(options: HookStreamOptions) {
  const source = (options.createSource ?? ((url) => new EventSource(url)))(`/api/modules/hooks/stream?${options.query}`);
  let active = true;
  let ready = false;
  let hasSnapshot = false;
  let hasHistory = false;
  const cursors = { snapshot: -1, history: -1 };
  const listeners: [string, EventListener][] = [];

  function close() {
    active = false;
    for (const [name, listener] of listeners) source.removeEventListener(name, listener);
    source.close();
  }

  function listen(name: string, listener: (event: MessageEvent<string>) => void) {
    const guarded: EventListener = (event) => {
      if (active) listener(event as MessageEvent<string>);
    };
    listeners.push([name, guarded]);
    source.addEventListener(name, guarded);
  }

  function receive(kind: keyof typeof cursors, event: MessageEvent<string>) {
    const cursor = event.lastEventId ? Number(event.lastEventId) : undefined;
    if (cursor !== undefined && Number.isFinite(cursor) && cursor < cursors[kind]) return;
    try {
      const value = JSON.parse(event.data);
      if (kind === "snapshot") {
        if (!value || !Array.isArray(value.bindings) || !Array.isArray(value.handlers) || !Array.isArray(value.handler_activity) || !value.hub || !value.totals) throw new Error("Invalid hook overview");
        options.onSnapshot(value as HookSnapshot);
        hasSnapshot = true;
      } else {
        if (!value || !Array.isArray(value.items) || !Number.isFinite(value.total) || !Number.isFinite(value.offset)) throw new Error("Invalid execution history");
        const history = value as HookHistory;
        if (history.items.some((invocation) => !invocation || typeof invocation.invocation_id !== "string" || typeof invocation.updated_at !== "string" || !Array.isArray(invocation.executions))) throw new Error("Invalid invocation");
        // Replayed updates may repeat an invocation; one invocation owns one row.
        const unique = new Map<string, HookHistory["items"][number]>();
        for (const invocation of history.items) {
          const previous = unique.get(invocation.invocation_id);
          if (!previous || (invocation.revision ?? Date.parse(invocation.updated_at)) >= (previous.revision ?? Date.parse(previous.updated_at))) unique.set(invocation.invocation_id, invocation);
        }
        options.onHistory({ ...history, items: [...unique.values()] });
        hasHistory = true;
      }
      if (cursor !== undefined && Number.isFinite(cursor)) cursors[kind] = cursor;
      if (hasSnapshot && hasHistory) {
        ready = true;
        options.onConnection("live");
        if (options.once) close();
      }
    } catch {
      options.onError(kind === "snapshot" ? "The hook overview could not be read. Refresh to try again." : "The execution history could not be read. Refresh to try again.");
    }
  }

  listen("open", () => {
    // Every connection bootstraps an authoritative projection. Its local
    // cursor may restart after the collector's read model is rebuilt.
    cursors.snapshot = -1;
    cursors.history = -1;
    hasSnapshot = false;
    hasHistory = false;
    options.onConnection(ready ? "reconnecting" : "connecting");
  });
  listen("hooks-status", (event) => receive("snapshot", event));
  listen("hooks-history", (event) => receive("history", event));
  listen("error", () => {
    const closed = source.readyState === 2;
    options.onConnection(closed ? "offline" : "reconnecting");
    options.onError(closed ? "Live updates are unavailable. Refresh to reconnect." : "Live updates were interrupted. Reconnecting automatically; you can also refresh.");
  });
  return close;
}

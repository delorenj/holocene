// The Genesis tab's live feed: /api/modules/genesis/stream sends the whole overview on connect and again whenever a
// Genesis fact (or an acknowledgement) lands, coalesced server-side. Every frame is absolute state, so a reconnect
// needs no cursor. Modelled on ../candybar/schedule-stream.ts: the page owns recovery (a proxy's 502 stops a
// browser's own retries), with backoff up to 30 s. The page also polls slowly, so a dead stream only costs latency.

export type StreamStatus = "connecting" | "live" | "reconnecting";

type Source = Pick<EventSource, "addEventListener" | "removeEventListener" | "close">;

export type GenesisStreamOptions<T> = {
  onOverview: (data: T) => void;
  onStatus: (status: StreamStatus, detail?: string) => void;
  createSource?: (url: string) => Source;
  url?: string;
};

export function subscribeGenesis<T>(options: GenesisStreamOptions<T>): () => void {
  const createSource = options.createSource ?? ((url) => new EventSource(url));
  const url = options.url ?? "/api/modules/genesis/stream";
  let active = true;
  let retryDelay = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;

  function reconnect() {
    if (!active) return;
    release?.();
    release = undefined;
    options.onStatus("reconnecting", `Live updates were interrupted; retrying in ${Math.round(retryDelay / 1000)}s.`);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  }

  function connect() {
    retryTimer = undefined;
    if (!active) return;
    let source: Source;
    try {
      source = createSource(url);
    } catch {
      reconnect();
      return;
    }
    let current = true;
    const listeners: Array<[string, EventListener]> = [];
    release = () => {
      current = false;
      for (const [name, listener] of listeners) source.removeEventListener(name, listener);
      source.close();
    };
    const listen = (name: string, listener: (event: MessageEvent<string>) => void) => {
      const guarded: EventListener = (event) => {
        if (active && current) listener(event as MessageEvent<string>);
      };
      listeners.push([name, guarded]);
      source.addEventListener(name, guarded);
    };
    listen("open", () => options.onStatus("live"));
    listen("overview", (event) => {
      let data: T;
      try {
        data = JSON.parse(event.data) as T;
      } catch {
        return; // the next frame is absolute state again
      }
      retryDelay = 1000;
      options.onStatus("live");
      options.onOverview(data);
    });
    listen("error", () => reconnect());
  }

  options.onStatus("connecting");
  connect();
  return () => {
    active = false;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    release?.();
    release = undefined;
  };
}

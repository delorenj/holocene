// The Schedule view's live feed: Candybar's /schedule/stream, piped through the Holocene API. Modelled on
// ../hooks/stream.ts: the page owns recovery for every failure (a proxy's 502 stops a browser's own retries), and
// each reconnect carries the last seen id as `after`, so Candybar replays exactly the missed events or answers
// `reset` when it cannot (a restart changes the <boot> prefix; the replay buffer holds 1024 events). The API pings
// every 15 s between frames; a line silent for 45 s is dead (a proxy can drop it without an error) and is replaced.

export type StreamStatus = "connecting" | "live" | "reconnecting";

type Source = Pick<EventSource, "addEventListener" | "removeEventListener" | "close">;

export const STREAM_EVENTS = [
  "ready",
  "invocation.started",
  "invocation.completed",
  "skip.applied",
  "definition.changed",
  "current.advanced",
  "reset"
] as const;

const SILENCE_MS = 45_000;

export type ScheduleStreamOptions = {
  from: string;
  to: string;
  onEvent: (name: string, data: unknown) => void;
  onStatus: (status: StreamStatus, detail?: string) => void;
  createSource?: (url: string) => Source;
};

export function subscribeSchedule(options: ScheduleStreamOptions): () => void {
  const createSource = options.createSource ?? ((url) => new EventSource(url));
  let active = true;
  let lastId = "";
  let retryDelay = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const heard = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => reconnect("Live updates went silent"), SILENCE_MS);
  };

  const disconnect = () => {
    clearTimeout(watchdog);
    watchdog = undefined;
    release?.();
    release = undefined;
  };

  function reconnect(why = "Live updates were interrupted") {
    if (!active) return;
    disconnect();
    options.onStatus("reconnecting", `${why}; retrying in ${Math.round(retryDelay / 1000)}s.`);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  }

  function connect() {
    retryTimer = undefined;
    if (!active) return;
    const query = new URLSearchParams({ from: options.from, to: options.to });
    if (lastId) query.set("after", lastId);
    let source: Source;
    try {
      source = createSource(`/api/modules/candybar/schedule/stream?${query}`);
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

    // Open means the proxy reached Candybar; a resumed stream may carry nothing but pings until the next tick.
    listen("open", () => {
      heard();
      options.onStatus("live");
    });
    listen("ping", heard);
    for (const name of STREAM_EVENTS) {
      listen(name, (event) => {
        heard();
        if (event.lastEventId) lastId = event.lastEventId;
        let data: unknown;
        try {
          data = JSON.parse(event.data);
        } catch {
          return; // one unreadable frame is skipped; the next absolute-state event repairs the row
        }
        retryDelay = 1000;
        options.onEvent(name, data);
      });
    }
    listen("error", () => reconnect());
  }

  options.onStatus("connecting");
  connect();
  return () => {
    active = false;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    disconnect();
  };
}

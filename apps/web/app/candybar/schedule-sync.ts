import { applyEvent, fromSnapshot, type Model } from "./schedule-model";
import type { SchedulePayload } from "./types";

// How the Schedule view keeps its model in step with Candybar: one /schedule snapshot, then the stream's events applied
// on top. Plain and DOM-free (the fetch, the timers and the view's state are injected), so the ordering rules are tested
// directly. The rules:
//
//   * `loaded` is false from the moment a snapshot is wanted until the LAST queued snapshot read has completed. Events
//     heard meanwhile are buffered and applied on top of the snapshot that answers, never to a model that is about to be
//     replaced (N3: a read already in flight when another was asked for used to flip `loaded` early).
//   * Everything heard before a read starts is older than the snapshot it returns, so each read starts with an empty
//     buffer; this also bounds the buffer while Candybar keeps refusing the snapshot.
//   * `reset` clears what was buffered, and asks for a fresh snapshot.

export type SyncLoad = { status: "ok" } | { status: "error"; error: string };

export type SyncDeps = {
  /** Fetches the day's snapshot; throws with a readable message when it fails. */
  fetchSnapshot: (signal: AbortSignal) => Promise<SchedulePayload>;
  getModel: () => Model;
  setModel: (model: Model) => void;
  onLoad: (load: SyncLoad) => void;
  /** The model changed: render once per frame. */
  bump: () => void;
  retryMs: number;
  after: (fn: () => void, ms: number) => unknown;
  cancelAfter: (handle: unknown) => void;
};

export function createScheduleSync(deps: SyncDeps) {
  let alive = true;
  let loaded = false;
  let loading = false;
  let again = false;
  let retry: unknown;
  let ctl: AbortController | undefined;
  const pending: Array<[string, unknown]> = [];

  async function read(): Promise<void> {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    again = false;
    if (retry !== undefined) deps.cancelAfter(retry);
    retry = undefined;
    pending.length = 0;
    ctl = new AbortController();
    try {
      // Candybars the stream archived stay out even if the API's list had not caught up yet.
      const model = fromSnapshot(await deps.fetchSnapshot(ctl.signal), deps.getModel().archived);
      if (!alive) return;
      // Events that arrived while the snapshot was read are applied on top; each is absolute state.
      let refetch = false;
      for (const [name, data] of pending.splice(0)) refetch = applyEvent(model, name, data) === "refetch" || refetch;
      deps.setModel(model);
      if (refetch) again = true;
      // Another read is queued behind this one: keep buffering until it lands, or its events would go to this model.
      loaded = !again;
      deps.onLoad({ status: "ok" });
      deps.bump();
    } catch (err) {
      if (!alive || ctl?.signal.aborted) return;
      deps.onLoad({ status: "error", error: err instanceof Error ? err.message : String(err) });
      retry = deps.after(() => void read(), deps.retryMs);
    } finally {
      loading = false;
      if (alive && again) void read();
    }
  }

  return {
    read,
    /** A row action moved fires (a rest-of-day skip): buffer like a `reset` until the new snapshot lands. */
    refetch() {
      loaded = false;
      void read();
    },
    /** One stream event: applied now when the model is current, buffered while a snapshot is on its way. */
    event(name: string, data: unknown) {
      if (!loaded) {
        pending.push([name, data]);
        if (name === "reset") pending.length = 0;
        return;
      }
      if (applyEvent(deps.getModel(), name, data) === "refetch") {
        loaded = false;
        void read();
      } else deps.bump();
    },
    get loaded() {
      return loaded;
    },
    dispose() {
      alive = false;
      ctl?.abort();
      if (retry !== undefined) deps.cancelAfter(retry);
    }
  };
}

export type ScheduleSync = ReturnType<typeof createScheduleSync>;

import type { CandybarRow, Task } from "./types";

// Row-action state that must outlive the components showing it: a panel collapsed and reopened, or a row that moved
// to another section (and so remounted), still knows which request is in flight, which task it just queued, what the
// last result was, and where focus should land. One store for the page; DOM-free, so it is tested directly.

export type Note = { tone: "error" | "info" | "done"; text: string; at: number };
/** `assertive`: a failure, read at once (role="alert"); the rest wait their turn (polite). */
export type Announcement = { text: string; seq: number; assertive?: boolean };
export type FocusIntent = { candybarId: string; key: string; until: number };

export type ActionState = {
  /** Action keys with a request in flight (`<candybarId>:<action>[:<detail>]`). */
  busy: ReadonlySet<string>;
  /** Tasks a steward request just queued, by `<candybarId>:<action>`, until the list shows them. */
  queued: ReadonlyMap<string, Task>;
  /** The latest result per candybar, shown in its panel. */
  notes: ReadonlyMap<string, Note>;
  /** The latest result for the page's polite live region. */
  announcement: Announcement;
};

/** `<candybarId>:<action>`, plus a detail (a fire time) for actions that act on one fire. */
export const actionKey = (candybarId: string, action: string, detail?: string) => (detail ? `${candybarId}:${action}:${detail}` : `${candybarId}:${action}`);

/** How long a focus intent waits for its row to settle in its new place. It also ends the moment the operator takes
 *  over: any pointerdown or keydown (see focus-intent.ts). */
export const FOCUS_INTENT_MS = 15_000;

export function createActionStore() {
  let state: ActionState = { busy: new Set(), queued: new Map(), notes: new Map(), announcement: { text: "", seq: 0 } };
  let intent: FocusIntent | undefined;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ActionState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => state,
    isBusy: (key: string) => state.busy.has(key),
    /** Claims a key for one request. False when it is already in flight: the second click sends nothing. */
    begin(key: string): boolean {
      if (state.busy.has(key)) return false;
      set({ busy: new Set(state.busy).add(key) });
      return true;
    },
    end(key: string) {
      if (!state.busy.has(key)) return;
      const busy = new Set(state.busy);
      busy.delete(key);
      set({ busy });
    },
    remember(task: Task) {
      set({ queued: new Map(state.queued).set(actionKey(task.candybarId, task.action), task) });
    },
    pending: (candybarId: string, action: string): Task | undefined => state.queued.get(actionKey(candybarId, action)),
    /** Forgets a just-queued task by id (it was cancelled), so the button does not wait for a list that already moved on. */
    forget(taskId: string) {
      const queued = new Map(state.queued);
      for (const [key, task] of state.queued) if (task.id === taskId) queued.delete(key);
      if (queued.size !== state.queued.size) set({ queued });
    },
    /** Forgets the queued tasks the list now shows (as active, or as the newest of their action). */
    reconcile(rows: Array<Pick<CandybarRow, "id" | "tasks">>) {
      if (!state.queued.size) return;
      const byId = new Map(rows.map((r) => [r.id, r]));
      const queued = new Map(state.queued);
      for (const [key, task] of state.queued) {
        const tasks = byId.get(task.candybarId)?.tasks;
        if (!tasks) continue;
        const latest = tasks.latest[task.action];
        const shown = tasks.active.some((t) => t.id === task.id) || (latest && (latest.id === task.id || Date.parse(latest.createdAt) >= Date.parse(task.createdAt)));
        if (shown) queued.delete(key);
      }
      if (queued.size !== state.queued.size) set({ queued });
    },
    note(candybarId: string, note: Omit<Note, "at"> | undefined, at = Date.now()) {
      const notes = new Map(state.notes);
      if (note) notes.set(candybarId, { ...note, at });
      else notes.delete(candybarId);
      set({ notes });
    },
    announce(text: string, assertive = false) {
      set({ announcement: { text, seq: state.announcement.seq + 1, ...(assertive ? { assertive } : {}) } });
    },
    /** After a change that can move or remove the row, focus follows it (see the app's focus effect). */
    intendFocus(candybarId: string, key: string, now = Date.now()) {
      intent = { candybarId, key, until: now + FOCUS_INTENT_MS };
    },
    focusIntent(now = Date.now()): FocusIntent | undefined {
      if (intent && now > intent.until) intent = undefined;
      return intent;
    },
    clearFocusIntent() {
      intent = undefined;
    }
  };
}

export type ActionStore = ReturnType<typeof createActionStore>;

/** The page's one store. */
export const actionStore = createActionStore();

/** The live region's text. The same words twice must still be heard, so every other announcement gains a trailing
 *  no-break space: the text changes, the reading does not. */
export const liveText = (a: Announcement) => (a.seq % 2 ? a.text : `${a.text} `);

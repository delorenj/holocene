import type { ActionResult } from "./candybar-api";
import { actionKey, type ActionStore } from "./action-store";
import type { RunOutcome } from "./row-actions";
import { restOfDay, type Fire } from "./schedule-model";

// One click on a Schedule row's actions (Skip, Skip rest of day, Mark noise), start to finish, with its side effects
// behind dependencies so it is tested without a DOM. Busy state is per row and action in the page's store, so two
// rows act independently, a remounted row still knows its request is in flight, and a second click sends nothing.
// Noise shares its key with the Definitions action bar: one candybar, one noise request at a time.

export type FireAction = "skip" | "rest" | "noise";

/** What a row offers: skips only for a fire still to come and not already skipped; noise always. */
export function fireActionsFor(f: Pick<Fire, "state" | "skipped">): FireAction[] {
  return f.state !== "past" && !f.skipped ? ["skip", "rest", "noise"] : ["noise"];
}

export function fireActionKey(f: Pick<Fire, "candybarId" | "fireTime">, action: FireAction): string {
  if (action === "skip") return actionKey(f.candybarId, "skip", f.fireTime);
  return actionKey(f.candybarId, action === "rest" ? "rest" : "noise");
}

export const fireActionLabel = (f: Pick<Fire, "noise">, action: FireAction) =>
  action === "skip" ? "Skip" : action === "rest" ? "Skip rest of day" : f.noise ? "Unmark noise" : "Mark noise";

export type FireDeps = {
  store: ActionStore;
  post: (candybarId: string, path: string, body: Record<string, unknown>) => Promise<ActionResult>;
  confirm: (text: string) => boolean;
  /** The candybar's own zone, when known: the rest-of-day confirm names the date and hours it covers. */
  zone?: string;
  /** The viewer's zone and the end of the day this view lists. */
  viewer?: string;
  viewEnd?: number;
  /** Whether noisy fires are listed; marking noise hides the row otherwise, and the result says so. */
  showNoise: boolean;
  clock: (t: number) => string;
  now?: () => number;
  /** Local updates ahead of the stream, and the visible failure notice. */
  onSkipped: (key: string) => void;
  onNoise: (candybarId: string, noise: boolean) => void;
  onRefetch: () => void;
  onError: (text: string) => void;
};

const zoneWord = (z: unknown) => (z === "Etc/UTC" ? "UTC" : typeof z === "string" ? z : undefined);

export async function runFireAction(f: Fire, action: FireAction, deps: FireDeps): Promise<RunOutcome> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const key = fireActionKey(f, action);
  if (store.isBusy(key)) return "busy";
  if (action !== "noise" && !fireActionsFor(f).includes(action)) return "blocked";
  let expectDate: string | undefined;
  if (action === "rest") {
    const plan = restOfDay({ name: f.name, fireT: f.t, zone: deps.zone, now: now(), viewer: deps.viewer, viewEnd: deps.viewEnd });
    if (!deps.confirm(plan.confirm)) return "dismissed";
    expectDate = plan.date;
  }
  if (!store.begin(key)) return "busy";
  let r: ActionResult;
  try {
    r =
      action === "skip"
        ? await deps.post(f.candybarId, "skip", { fireTime: f.fireTime })
        : action === "rest"
          ? await deps.post(f.candybarId, "skip-rest-of-day", { fireTime: f.fireTime, ...(expectDate ? { expectDate } : {}) })
          : await deps.post(f.candybarId, "noise", { noise: !f.noise });
  } finally {
    store.end(key);
  }
  if (!r.ok) {
    const text = `${fireActionLabel(f, action)} failed for ${f.name}: ${r.error}${r.status ? ` (${r.status})` : ""}`;
    deps.onError(text);
    store.announce(text, true);
    return "sent";
  }
  let text: string;
  if (action === "skip") {
    deps.onSkipped(f.key);
    text = `Skipped ${f.name} at ${deps.clock(f.t)}.`;
  } else if (action === "rest") {
    deps.onRefetch();
    const date = typeof r.body.date === "string" ? r.body.date : expectDate;
    const zone = zoneWord(r.body.timezone) ?? zoneWord(deps.zone);
    text = date ? `Skipped every fire of ${f.name} on ${date}${zone ? ` (${zone})` : ""}.` : `Skipped the rest of ${f.name}'s day.`;
  } else {
    deps.onNoise(f.candybarId, !f.noise);
    text = !f.noise
      ? `Marked ${f.name} as noise.${deps.showNoise ? "" : " Its fires are hidden now; tick Show noise to list them."}`
      : `${f.name} is no longer noise.`;
  }
  store.announce(text);
  return "sent";
}

import type { FireState, SchedulePayload, WireRow } from "./types";

// The Schedule view's state and the contract's patch rules (candybar holocene-view-contract.md, "Live updates").
// Every stream payload is absolute state, so applying one twice changes nothing. Pure and DOM-free so it is tested
// directly; the view keeps one Model in a ref and re-renders on `version`.

export type Fire = {
  key: string;
  candybarId: string;
  name: string;
  schedule: string;
  fireTime: string;
  t: number;
  state: FireState;
  lastResult?: "success" | "fail";
  skipped: boolean;
  noise: boolean;
  /** Started on the stream and not completed yet. A snapshot cannot tell running from never-ran. */
  running?: boolean;
};

export type Model = { fires: Map<string, Fire>; cut?: number; version: number };

export const emptyModel = (): Model => ({ fires: new Map(), version: 0 });

export const fireKey = (candybarId: string, fireTime: string) => `${candybarId}@${fireTime}`;

function toFire(row: WireRow, prev?: Fire): Fire | undefined {
  const t = Date.parse(row.fireTime);
  if (!row.candybarId || !Number.isFinite(t)) return undefined;
  const lastResult = row.lastResult ?? prev?.lastResult;
  return {
    key: fireKey(row.candybarId, row.fireTime),
    candybarId: row.candybarId,
    name: typeof row.name === "string" ? row.name : prev?.name ?? row.candybarId,
    schedule: typeof row.schedule === "string" ? row.schedule : prev?.schedule ?? "",
    fireTime: row.fireTime,
    t,
    state: row.state,
    // A result, once recorded, is not lost to a late `invocation.started` replayed on top of a newer snapshot.
    lastResult,
    // Candybar's own rule (schedule.py): a fire is skipped only if it never ran. A rest-of-day skip is recorded
    // against the day's first fire, which has usually run already.
    skipped: row.skipped === true && !lastResult,
    noise: row.noise === true,
    running: prev?.running
  };
}

export function fromSnapshot(p: SchedulePayload): Model {
  const fires = new Map<string, Fire>();
  if (!Array.isArray(p?.rows) || !Array.isArray(p?.candybars)) throw new Error("the schedule snapshot is malformed");
  for (const [i, fireTime, state, result, skipped] of p.rows) {
    const c = p.candybars[i];
    if (!c) continue;
    const f = toFire({ candybarId: c.id, name: c.name, schedule: c.schedule, fireTime, state, skipped: skipped === 1, noise: c.noise, ...(result ? { lastResult: result } : {}) });
    if (f) fires.set(f.key, f);
  }
  return { fires, version: 1 };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function asRow(v: unknown): WireRow | undefined {
  if (!isRecord(v) || typeof v.candybarId !== "string" || typeof v.fireTime !== "string") return undefined;
  if (v.state !== "past" && v.state !== "current" && v.state !== "upcoming") return undefined;
  return v as unknown as WireRow;
}

/** "rows with fireTime < cut become past, the row matching current becomes current, the rest become upcoming". */
function advance(m: Model, cutIso: unknown, current: unknown) {
  const cut = typeof cutIso === "string" ? Date.parse(cutIso) : NaN;
  if (!Number.isFinite(cut)) return;
  m.cut = cut;
  const row = asRow(current);
  // `current` is not window-filtered (it may be tomorrow's first fire), so it only marks a row we already hold.
  const currentKey = row ? fireKey(row.candybarId, row.fireTime) : undefined;
  for (const f of m.fires.values()) {
    const state: FireState = f.t < cut ? "past" : f.key === currentKey ? "current" : "upcoming";
    if (f.state !== state) m.fires.set(f.key, { ...f, state });
  }
}

/** Applies one stream event in place. Returns "refetch" when the contract says the client must reload /schedule. */
export function applyEvent(m: Model, name: string, data: unknown): "ok" | "refetch" | "ignored" {
  if (!isRecord(data)) return "ignored";
  switch (name) {
    case "ready":
    case "current.advanced":
      advance(m, data.cut, data.current);
      break;
    case "reset":
      return "refetch";
    case "invocation.started":
    case "invocation.completed":
    case "skip.applied": {
      // One rest-of-day fact suppresses every later fire that day, but the stream carries only its first row.
      if (name === "skip.applied" && data.reason === "rest_of_day") return "refetch";
      const row = asRow(data.row);
      if (!row) return "ignored"; // a manual run or a system skip with no schedule row
      const key = fireKey(row.candybarId, row.fireTime);
      const f = toFire(row, m.fires.get(key));
      if (!f) return "ignored";
      if (name === "invocation.started" && !f.lastResult) f.running = true;
      if (name === "invocation.completed") {
        f.running = false;
        if (data.result === "success" || data.result === "fail") f.lastResult = data.result;
      }
      m.fires.set(key, f);
      break;
    }
    case "definition.changed": {
      const id = typeof data.candybarId === "string" ? data.candybarId : undefined;
      if (!id) return "ignored";
      if (Array.isArray(data.rows)) {
        // A windowed stream sends the candybar's rows for the whole window: they replace what we hold.
        const prev = new Map<string, Fire>();
        for (const [k, f] of m.fires) if (f.candybarId === id) (prev.set(k, f), m.fires.delete(k));
        for (const r of data.rows) {
          const row = asRow(r);
          const f = row && toFire(row, prev.get(fireKey(row.candybarId, row.fireTime)));
          if (f) m.fires.set(f.key, f);
        }
      } else {
        const def = isRecord(data.definition) ? data.definition : {};
        if ("enabled" in (isRecord(data.changes) ? data.changes : {}) || "schedule" in (isRecord(data.changes) ? data.changes : {})) return "refetch";
        for (const [k, f] of m.fires) {
          if (f.candybarId !== id) continue;
          m.fires.set(k, {
            ...f,
            name: typeof def.name === "string" ? def.name : f.name,
            schedule: typeof def.schedule === "string" ? def.schedule : f.schedule,
            noise: typeof def.noise === "boolean" ? def.noise : f.noise
          });
        }
      }
      break;
    }
    default:
      return "ignored";
  }
  m.version += 1;
  return "ok";
}

export const byTime = (a: Fire, b: Fire) => a.t - b.t || a.name.localeCompare(b.name);

/** Marks one fire skipped as soon as Candybar accepted the skip; the stream's `skip.applied` then says the same. */
export function markSkipped(m: Model, key: string): boolean {
  const f = m.fires.get(key);
  if (!f || f.skipped) return false;
  m.fires.set(key, { ...f, skipped: true });
  m.version += 1;
  return true;
}

/** Sets the noise flag on every fire of a candybar, ahead of the stream's `definition.changed`. */
export function setNoise(m: Model, candybarId: string, noise: boolean): void {
  for (const [k, f] of m.fires) if (f.candybarId === candybarId && f.noise !== noise) m.fires.set(k, { ...f, noise });
  m.version += 1;
}

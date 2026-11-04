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
  /** The candybar's own zone (a rest-of-day skip covers one date in it); absent when the API could not say. */
  timezone?: string;
  /** Started on the stream and not completed yet. A snapshot cannot tell running from never-ran. */
  running?: boolean;
};

/** `archived`: candybars archived while the view was open. Their rows are dropped and later row events ignored. */
export type Model = { fires: Map<string, Fire>; cut?: number; version: number; archived: Set<string> };

export const emptyModel = (): Model => ({ fires: new Map(), version: 0, archived: new Set() });

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
    ...(prev?.timezone ? { timezone: prev.timezone } : {}),
    running: prev?.running
  };
}

/**
 * `archived` carries the ids the stream archived across a refetch: the API hides archived candybars from the snapshot
 * using a list that may be a few seconds old. An unarchive (or any later definition.changed saying archived: false)
 * takes an id back out.
 */
export function fromSnapshot(p: SchedulePayload, archived: ReadonlySet<string> = new Set()): Model {
  const fires = new Map<string, Fire>();
  if (!Array.isArray(p?.rows) || !Array.isArray(p?.candybars)) throw new Error("the schedule snapshot is malformed");
  for (const [i, fireTime, state, result, skipped] of p.rows) {
    const c = p.candybars[i];
    if (!c || archived.has(c.id)) continue;
    const f = toFire({ candybarId: c.id, name: c.name, schedule: c.schedule, fireTime, state, skipped: skipped === 1, noise: c.noise, ...(result ? { lastResult: result } : {}) });
    if (f) fires.set(f.key, typeof c.timezone === "string" ? { ...f, timezone: c.timezone } : f);
  }
  return { fires, version: 1, archived: new Set(archived) };
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
      if (m.archived.has(row.candybarId)) return "ignored";
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
      const def = isRecord(data.definition) ? data.definition : {};
      const changes = isRecord(data.changes) ? data.changes : {};
      // An archived candybar leaves the schedule: its rows go, even the past runs a windowed stream still sends.
      const archived = typeof def.archived === "boolean" ? def.archived : changes.archived === true;
      if (archived) {
        for (const [k, f] of m.fires) if (f.candybarId === id) m.fires.delete(k);
        m.archived.add(id);
        break;
      }
      const wasArchived = m.archived.delete(id);
      const zone = typeof def.timezone === "string" ? def.timezone : undefined;
      if (Array.isArray(data.rows)) {
        // A windowed stream sends the candybar's rows for the whole window: they replace what we hold.
        const prev = new Map<string, Fire>();
        for (const [k, f] of m.fires) if (f.candybarId === id) (prev.set(k, f), m.fires.delete(k));
        for (const r of data.rows) {
          const row = asRow(r);
          const f = row && toFire(row, prev.get(fireKey(row.candybarId, row.fireTime)));
          if (f) m.fires.set(f.key, zone ? { ...f, timezone: zone } : f);
        }
      } else {
        if (wasArchived || "enabled" in changes || "schedule" in changes || "archived" in changes) return "refetch";
        for (const [k, f] of m.fires) {
          if (f.candybarId !== id) continue;
          m.fires.set(k, {
            ...f,
            name: typeof def.name === "string" ? def.name : f.name,
            schedule: typeof def.schedule === "string" ? def.schedule : f.schedule,
            noise: typeof def.noise === "boolean" ? def.noise : f.noise,
            ...(zone ? { timezone: zone } : {})
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

// ---------- skip rest of day: which date, and which hours of the viewer's clock ----------

/** The `YYYY-MM-DD` of an instant in a zone (the API computes the same with the same call). */
export function localDate(t: number, timeZone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(t);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const [y, m, d] = [get("year"), get("month"), get("day")];
    return y && m && d ? `${y}-${m}-${d}` : undefined;
  } catch {
    return undefined; // an unknown zone name
  }
}

/** How far `zone`'s wall clock is ahead of UTC at instant `t`, in ms. */
function offsetAt(t: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(t);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return wall - (t - (t % 1000));
}

/** The instant 00:00 of `date` begins in `zone` (DST-aware: the offset is the one in force at that midnight). */
export function zonedMidnight(date: string, zone: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return undefined;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  try {
    let t = wall;
    for (let i = 0; i < 3; i += 1) {
      const next = wall - offsetAt(t, zone);
      if (next === t) break;
      t = next;
    }
    return t;
  } catch {
    return undefined;
  }
}

const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function fmt(t: number, zone: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: zone }).format(t);
}

/** "tonight", "today", "tomorrow", "yesterday", else "Wed Nov 5": a day on the viewer's clock, relative to now. */
function dayWord(t: number, now: number, zone: string): string {
  const diff = dayNumber(localDate(t, zone) ?? "") - dayNumber(localDate(now, zone) ?? "");
  const hour = Number(fmt(t, zone, { hour: "numeric", hourCycle: "h23" }));
  if (diff === 0) return hour >= 17 ? "tonight" : "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return fmt(t, zone, { weekday: "short", month: "short", day: "numeric" });
}

export type RestOfDay = {
  /** The candybar-local date that will be skipped (sent as expectDate); absent when the zone is unknown. */
  date?: string;
  zone?: string;
  /** The span on the viewer's clock, each end with its own zone, e.g. "7:00 PM tonight EST to 7:00 PM tomorrow EST". */
  range?: string;
  /** Whether the span runs past the end of the viewer's day, which is all this view lists. */
  beyondView: boolean;
  confirm: string;
};

/** What a rest-of-day skip of one fire covers, and the confirm that says so before anything is sent. */
export function restOfDay(input: { name: string; fireT: number; zone?: string; now: number; viewer?: string; viewEnd?: number }): RestOfDay {
  const viewer = input.viewer ?? viewerZone();
  const clock = (t: number) => fmt(t, viewer, { hour: "numeric", minute: "2-digit" });
  const date = input.zone ? localDate(input.fireT, input.zone) : undefined;
  const start = date && input.zone ? zonedMidnight(date, input.zone) : undefined;
  const end = date && input.zone ? zonedMidnight(nextDate(date), input.zone) : undefined;
  if (!date || !input.zone || start === undefined || end === undefined) {
    return {
      beyondView: false,
      confirm: `Skip every fire of ${input.name} on the day of its ${clock(input.fireT)} fire, in the candybar's own time zone?\n\nHolocene could not read that zone, so it cannot say which hours of your day that covers.`
    };
  }
  const zoneLabel = input.zone === "Etc/UTC" ? "UTC" : input.zone;
  // Each end carries its own abbreviation: across a DST change the start is EDT where the end is EST.
  const abbr = (t: number) => new Intl.DateTimeFormat("en-US", { timeZone: viewer, timeZoneName: "short" }).formatToParts(t).find((p) => p.type === "timeZoneName")?.value ?? "";
  const midnight = (t: number) => fmt(t, viewer, { hour: "numeric", minute: "2-digit", hourCycle: "h23" }) === "00:00";
  const range = midnight(start) && midnight(end)
    ? `all day ${dayWord(start, input.now, viewer)}`
    : `${clock(start)} ${dayWord(start, input.now, viewer)} ${abbr(start)} to ${clock(end)} ${dayWord(end, input.now, viewer)} ${abbr(end)}`;
  const beyondView = input.viewEnd !== undefined && end > input.viewEnd;
  const note = beyondView ? "\n\nThis view lists only your day, so the fires after midnight are skipped without showing here." : "";
  return { date, zone: zoneLabel, range, beyondView, confirm: `Skip every fire of ${input.name} on ${date} (${zoneLabel}), ${range}?${note}` };
}

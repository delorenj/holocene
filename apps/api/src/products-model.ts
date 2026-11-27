import { load } from "js-yaml";
import { parseLaunchFile } from "./live-model.js";

export type Stage = "launch" | "live" | "polish";
export type LaunchState = { state: "attention" | "unknown" | "stale"; openActions?: number; ownerBlockers?: number; nextStep: string; observedAt?: string; source: "launch dashboard receipt" };
export type Product = {
  id: string;
  name: string;
  stage: Stage;
  declaration: { commit: string };
  destination?: { href: string; label: string; publishedAt?: string };
  launch?: LaunchState;
  issue?: string;
};
export type ProductIssue = { id: string; name: string; state: "missing" | "invalid" | "unavailable"; detail: string };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const meaningful = (v: unknown): v is string => nonempty(v) && v.trim().length >= 8 && !/^(?:(?:jarad|the owner|owner|he|user)\b.{0,40}\b(?:said|says|replied|reply|confirmed|told|messaged)\b|(?:done|ok|okay|yes|replied|confirmed)\W*$)/i.test(v);

function observation(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!m) return undefined;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const civil = new Date(0);
  civil.setUTCFullYear(year, month - 1, day);
  civil.setUTCHours(hour, minute, second, 0);
  if (civil.getUTCFullYear() !== year || civil.getUTCMonth() !== month - 1 || civil.getUTCDate() !== day ||
      civil.getUTCHours() !== hour || civil.getUTCMinutes() !== minute || civil.getUTCSeconds() !== second ||
      (m[8] && (Number(m[8]) > 23 || Number(m[9]) > 59))) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function classifyProduct(raw: string): { stage?: Stage; steady?: true; live?: true; issue?: string } {
  let doc: unknown;
  try { doc = load(raw); } catch { return { issue: "Committed .launch.yaml is invalid YAML." }; }
  // Modes are lowercased; `steady` is the legacy alias of `develop` (both mean: no product stage).
  const mode = record(doc) && typeof doc.mode === "string" ? doc.mode.trim().toLowerCase() : undefined;
  if (!mode || !["develop", "launch", "live", "polish", "steady"].includes(mode)) return { issue: "Committed .launch.yaml has a missing or unknown mode." };
  if (mode === "develop" || mode === "steady") return { steady: true };
  if (mode === "launch") return { stage: "launch" };
  const live = parseLaunchFile(raw);
  if (mode === "polish") {
    // Polishing a product already in production keeps its valid live: block (and its Live hub card);
    // a polish declaration without one is simply a polish-stage product, never a live-block problem.
    if (!record(doc) || doc.live === undefined) return { stage: "polish" };
    return { stage: "polish", ...(live.kind === "live" ? { live: true as const } : { issue: "Committed live declaration is invalid; inspect its live configuration." }) };
  }
  // Keep the declared classification visible, without leaking raw declaration values or key references.
  return { stage: "live", ...(live.kind !== "live" ? { issue: "Committed live declaration is invalid; inspect its live configuration." } : {}) };
}

export function launchEvidence(raw: unknown, now: number): LaunchState {
  const unknown: LaunchState = { state: "unknown", source: "launch dashboard receipt", nextStep: "Inspect missing or incomplete launch gate evidence; readiness and counts are unknown." };
  if (!record(raw) || raw.schema !== "launch-dashboard/1" || !Array.isArray(raw.items) || !record(raw.requirements)) return unknown;
  const items = raw.items;
  const requirements = Object.values(raw.requirements);
  if (!items.length || !requirements.length) return unknown;
  const ids = new Set<string>();
  for (const item of items) {
    if (!record(item) || typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id) || ids.has(item.id) || (item.status !== "open" && item.status !== "done") ||
        (item.status === "done" && !meaningful(item.evidence))) return unknown;
    ids.add(item.id);
  }
  if (requirements.some((gate) => !record(gate) ||
      (gate.status === "owner" ? !nonempty(gate.item) || !ids.has(gate.item) :
       gate.status === "agent" ? typeof gate.ref !== "string" || !/^[A-Z][A-Z0-9]*-[0-9]+$/.test(gate.ref) :
       gate.status === "met" ? !meaningful(gate.evidence) :
       gate.status === "na" ? !nonempty(gate.why) || gate.why.trim().length < 8 : true))) return unknown;
  // Publication time locates a dashboard, but cannot attest to gate freshness.
  const times = [...items, ...requirements].map((entry) => observation((entry as Record<string, unknown>).verified_at));
  if (times.some((time) => time === undefined || time > now)) return unknown;
  const observedAt = new Date(Math.min(...times as number[])).toISOString();
  const openActions = items.filter((item) => item.status === "open").length;
  const ownerBlockers = requirements.filter((gate) => (gate as Record<string, unknown>).status === "owner").length;
  const stale = now - Date.parse(observedAt) > 7 * 24 * 60 * 60 * 1000;
  return {
    state: stale ? "stale" : "attention",
    source: "launch dashboard receipt", observedAt, openActions, ownerBlockers,
    nextStep: stale ? "Recheck stale launch gates before relying on this dashboard." : ownerBlockers ? "Review owner-blocked launch gates in the dashboard." : openActions ? "Review open launch actions in the dashboard." : "Review gate evidence in the dashboard; no verified readiness is asserted."
  };
}

/** Publication receipts locate dashboards; they never classify a product or attest its health. */
export function publication(raw: unknown): Product["destination"] {
  if (!record(raw) || raw.schema !== "launch-dashboard/1" || !record(raw.published)) return undefined;
  const { url, at } = raw.published;
  if (typeof url !== "string" || typeof at !== "string" || !/^\d{4}-\d\d-\d\dT/.test(at) || !Number.isFinite(Date.parse(at))) return undefined;
  try {
    const u = new URL(url);
    if (u.href !== url || u.protocol !== "https:" || u.hostname !== "s3.delo.sh" || u.port || u.username || u.password || u.search || u.hash) return undefined;
    if (!/^\/projects\/[a-zA-Z0-9_-]+\/(?:[a-zA-Z0-9_-]+\/)*launch-dashboard\/index\.html$/.test(u.pathname) || /[%\\\s]/.test(url)) return undefined;
    return { href: u.href, label: "Open launch dashboard", publishedAt: new Date(at).toISOString() };
  } catch { return undefined; }
}

import { load } from "js-yaml";
import { parseLaunchFile } from "./live-model.js";

export type Stage = "launch" | "live";
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

export function classifyProduct(raw: string): { stage?: Stage; steady?: true; issue?: string } {
  let doc: unknown;
  try { doc = load(raw); } catch { return { issue: "Committed .launch.yaml is invalid YAML." }; }
  if (!record(doc) || typeof doc.mode !== "string" || !["launch", "live", "steady"].includes(doc.mode)) return { issue: "Committed .launch.yaml has a missing or unknown mode." };
  if (doc.mode === "steady") return { steady: true };
  if (doc.mode === "launch") return { stage: "launch" };
  const live = parseLaunchFile(raw);
  // Keep the declared classification visible, without leaking raw declaration values or key references.
  return { stage: "live", ...(live.kind !== "live" ? { issue: "Committed live declaration is invalid; inspect its live configuration." } : {}) };
}

export function launchEvidence(raw: unknown, now: number): LaunchState {
  const unknown: LaunchState = { state: "unknown", source: "launch dashboard receipt", nextStep: "Inspect launch evidence; readiness is unknown." };
  if (!record(raw) || raw.schema !== "launch-dashboard/1" || !Array.isArray(raw.items) || !record(raw.requirements)) return unknown;
  const items = raw.items;
  if (items.some((item) => !record(item) || (item.status !== "open" && item.status !== "done"))) return unknown;
  const requirements = Object.values(raw.requirements);
  if (requirements.some((gate) => !record(gate) || (gate.status !== "owner" && gate.status !== "agent" && gate.status !== "met" && gate.status !== "na"))) return unknown;
  const openActions = items.filter((item) => item.status === "open").length;
  const ownerBlockers = requirements.filter((gate) => (gate as Record<string, unknown>).status === "owner").length;
  // A publication timestamp only locates a dashboard; it is not evidence that its gates were rechecked.
  const times = [...items, ...requirements].map((entry) => (entry as Record<string, unknown>).verified_at);
  const verified = times.filter((t): t is string => typeof t === "string" && Number.isFinite(Date.parse(t)) && /^\d{4}-\d\d-\d\dT/.test(t) && Date.parse(t) <= now);
  const observedAt = verified.length ? new Date(Math.min(...verified.map((t) => Date.parse(t)))).toISOString() : undefined;
  const partial = times.some((t) => typeof t !== "string" || !Number.isFinite(Date.parse(t)) || !/^\d{4}-\d\d-\d\dT/.test(t) || Date.parse(t) > now);
  const stale = !!observedAt && now - Date.parse(observedAt) > 7 * 24 * 60 * 60 * 1000;
  return {
    state: stale ? "stale" : partial || !items.length || !requirements.length ? "unknown" : "attention",
    source: "launch dashboard receipt", ...(observedAt ? { observedAt } : {}),
    openActions, ownerBlockers,
    nextStep: stale ? "Recheck stale launch gates before relying on this dashboard." : partial ? "Recheck gates with missing observations in the dashboard." : ownerBlockers ? "Review owner-blocked launch gates in the dashboard." : openActions ? "Review open launch actions in the dashboard." : "Review gate evidence in the dashboard; no verified readiness is asserted."
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

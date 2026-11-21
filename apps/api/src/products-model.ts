import { load } from "js-yaml";
import { parseLaunchFile } from "./live-model.js";

export type Stage = "launch" | "live";
export type Product = {
  id: string;
  name: string;
  stage: Stage;
  declaration: { commit: string };
  destination?: { href: string; label: string; publishedAt?: string };
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

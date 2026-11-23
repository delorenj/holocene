import type { ProductsPayload } from "./types";

export const STAGE_LABEL = { launch: "Preparing to launch", live: "Live" } as const;

/** Host and path of a validated receipt URL, without the scheme or a trailing index file. */
export function receiptPath(href: string) {
  try {
    const url = new URL(href);
    return `${url.host}${url.pathname.replace(/\/index\.html?$/, "").replace(/\/$/, "")}`;
  } catch { return href; }
}

/** ISO timestamp as a compact UTC stamp; unparseable input is shown verbatim rather than guessed. */
export function stamp(iso: string) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** Invalid and unreadable declarations stay distinct and need attention; a missing declaration is the common, quiet case. */
export function groupIssues(issues: ProductsPayload["issues"]) {
  const by = (state: string) => issues.filter((i) => i.state === state);
  const known = new Set(["missing", "unavailable", "invalid"]);
  // Any future state is surfaced with the unreadable group rather than hidden.
  return { invalid: by("invalid"), unavailable: issues.filter((i) => i.state === "unavailable" || !known.has(i.state)), missing: by("missing") };
}

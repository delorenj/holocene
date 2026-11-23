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

/** Unreadable or invalid declarations need attention; a missing declaration is the common, quiet case. */
export function groupIssues(issues: ProductsPayload["issues"]) {
  return { actionable: issues.filter((i) => i.state !== "missing"), missing: issues.filter((i) => i.state === "missing") };
}

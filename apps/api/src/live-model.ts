// The Live hub's pure model: parsing a repo's `.launch.yaml` live block, and projecting each
// source the hub reads (release, storefront, Stripe, fulfilment) into the small, allowlisted
// shape the page shows. No IO here; live.ts does the reading and calls these.
//
// "Promotion to the Live hub" is not a registry. It is a registered pjangler project whose
// .launch.yaml says `mode: live` with a valid `live:` block (the contract below). Everything
// the page shows is either declared there or read from a source that block points at.
//
// Privacy: the Stripe projection keeps counts, amounts and times only. A Checkout Session's
// customer_details, email, name, address and ids never leave this file.

import { load } from "js-yaml";

type Json = Record<string, unknown>;
const record = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

// ---------------------------------------------------------------- the .launch.yaml contract

export type LiveCheckout = { provider: string; paymentLink: string; keyRef: string };
export type LiveFulfilment = {
  kind: string;
  promiseHours?: number;
  outstandingArgv: string[];
  reminderCandybar?: string;
};

export type LiveDecl = {
  declared?: string;
  liveSince: string;
  finishLine?: string;
  epic?: string;
  /** Repo-relative documents the launch named as its contract (shown as evidence links). */
  contract: string[];
  name: string;
  tagline: string;
  storeUrl: string;
  offer?: string;
  platform: string;
  package: string;
  release: string;
  board: string;
  support?: string;
  checkout?: LiveCheckout;
  fulfilment?: LiveFulfilment;
  /** A published demo video (v.delo.sh or s3.delo.sh share URL), embedded at the foot of the app's card. */
  video?: string;
};

/**
 * `showcase:` puts a product that is not promoted yet on the Live hub's "On deck" shelf: it is in real
 * use, it is headed for promotion, and the page shows what it is and its demo. Any mode but `live`
 * may carry one; a live app says the same things in its `live:` block.
 */
export type Showcase = {
  name: string;
  tagline: string;
  platform?: string;
  package?: string;
  note?: string;
  video?: string;
};

export type LaunchRead =
  | { kind: "absent" }
  | { kind: "not-live"; mode: string; showcase?: Showcase; showcaseProblems?: string[] }
  | { kind: "live"; decl: LiveDecl }
  | { kind: "invalid"; mode: "live"; problems: string[] };

/** js-yaml turns an unquoted 2026-11-20 into a Date; the contract treats it as the calendar day it names. */
export function dayOf(v: unknown): string | undefined {
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString().slice(0, 10);
  const s = text(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) ? s : undefined;
}

/** A share URL from the artifacts publisher: https on v.delo.sh (R2 video) or s3.delo.sh (MinIO), no query or fragment. */
export function publishedVideoUrl(v: unknown): string | undefined {
  const s = text(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || !["v.delo.sh", "s3.delo.sh"].includes(u.hostname) || u.port || u.username || u.search || u.hash) return undefined;
    return u.pathname.split("/").filter(Boolean).length >= 2 ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function parseShowcase(raw: unknown): { showcase?: Showcase; problems: string[] } {
  if (raw === undefined) return { problems: [] };
  if (!record(raw)) return { problems: ["showcase: must be a mapping"] };
  const problems: string[] = [];
  const name = text(raw.name);
  const tagline = text(raw.tagline);
  if (!name) problems.push("showcase.name is missing");
  if (!tagline) problems.push("showcase.tagline is missing");
  const video = publishedVideoUrl(raw.video);
  if (raw.video !== undefined && !video) problems.push("showcase.video must be a v.delo.sh or s3.delo.sh share URL");
  if (problems.length || !name || !tagline) return { problems };
  return {
    problems,
    showcase: { name, tagline, platform: text(raw.platform), package: text(raw.package), note: text(raw.note), video }
  };
}

const httpsUrl = (v: unknown): string | undefined => {
  const s = text(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Read one `.launch.yaml`. Anything but `mode: live` is not for this hub (`launch` and `steady` have
 * their own consumers). `mode: live` with a block that breaks the contract is reported as `invalid`
 * with every problem named, so a half-promoted app is visible instead of silently missing.
 */
export function parseLaunchFile(raw: string | undefined): LaunchRead {
  if (raw === undefined) return { kind: "absent" };
  let doc: unknown;
  try {
    doc = load(raw);
  } catch (error) {
    // A broken file cannot be told apart from a half-written live promotion: only name it if it says live.
    return /^\s*mode:\s*["']?live["']?\s*(#.*)?$/m.test(raw)
      ? { kind: "invalid", mode: "live", problems: [`.launch.yaml does not parse: ${(error as Error).message.split("\n")[0]}`] }
      : { kind: "not-live", mode: "unparseable" };
  }
  if (!record(doc)) return { kind: "absent" };
  const mode = (text(doc.mode) ?? "steady").toLowerCase();
  if (mode !== "live") {
    const { showcase, problems } = parseShowcase(doc.showcase);
    return { kind: "not-live", mode, ...(showcase ? { showcase } : {}), ...(problems.length ? { showcaseProblems: problems } : {}) };
  }

  const problems: string[] = [];
  const need = (label: string, value: string | undefined): string => {
    if (value === undefined) problems.push(`${label} is missing or invalid`);
    return value ?? "";
  };
  const live = record(doc.live) ? doc.live : undefined;
  if (!live) problems.push("live: block is missing");
  const l = live ?? {};

  const liveSince = need("live_since (YYYY-MM-DD)", dayOf(doc.live_since));
  const name = need("live.name", text(l.name));
  const tagline = need("live.tagline", text(l.tagline));
  const storeUrl = need("live.store_url (https)", httpsUrl(l.store_url));
  const platform = need("live.platform", text(l.platform));
  const pkg = need("live.package", text(l.package));
  const release = need("live.release (https latest.json)", httpsUrl(l.release));
  const board = need("live.board", text(l.board));

  let checkout: LiveCheckout | undefined;
  if (l.checkout !== undefined) {
    const c = record(l.checkout) ? l.checkout : {};
    const paymentLink = text(c.payment_link);
    const keyRef = text(c.key_ref);
    if (!paymentLink || !/^plink_[A-Za-z0-9]+$/.test(paymentLink)) problems.push("live.checkout.payment_link must be a plink_ id");
    if (!keyRef || !keyRef.startsWith("op://")) problems.push("live.checkout.key_ref must be an op:// reference");
    if (paymentLink && keyRef) checkout = { provider: text(c.provider) ?? "stripe", paymentLink, keyRef };
  }

  let fulfilment: LiveFulfilment | undefined;
  if (l.fulfilment !== undefined) {
    const f = record(l.fulfilment) ? l.fulfilment : {};
    const argv = Array.isArray(f.outstanding_argv) ? f.outstanding_argv : undefined;
    if (!argv || argv.length === 0 || argv.length > 40 || !argv.every((a) => typeof a === "string" && a.length > 0 && a.length < 400)) {
      problems.push("live.fulfilment.outstanding_argv must be a non-empty list of strings");
    } else {
      fulfilment = {
        kind: text(f.kind) ?? "manual",
        promiseHours: num(f.promise_hours),
        outstandingArgv: argv as string[],
        reminderCandybar: text(f.reminder_candybar)
      };
    }
  }

  const video = publishedVideoUrl(l.video);
  if (l.video !== undefined && !video) problems.push("live.video must be a v.delo.sh or s3.delo.sh share URL");

  if (problems.length) return { kind: "invalid", mode: "live", problems };
  return {
    kind: "live",
    decl: {
      declared: dayOf(doc.declared),
      liveSince,
      finishLine: text(doc.finish_line),
      epic: text(doc.epic),
      contract: Array.isArray(doc.contract) ? doc.contract.filter((c): c is string => typeof c === "string") : [],
      name,
      tagline,
      storeUrl,
      offer: text(l.offer),
      platform,
      package: pkg,
      release,
      board,
      support: text(l.support),
      checkout,
      fulfilment,
      video
    }
  };
}

/** Day 1 is the day it went live. Both arguments are calendar days (YYYY-MM-DD). */
export function daysLive(liveSince: string, today: string): number {
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${liveSince}T00:00:00Z`)) / 86_400_000);
  return Math.max(1, diff + 1);
}

/** Repo-relative, inside the repo, no dot segments; the only paths that may become evidence links. */
export function safeRelPath(p: string): string | undefined {
  if (!p || p.startsWith("/") || p.startsWith("~") || p.includes("\\") || p.includes("\0")) return undefined;
  const parts = p.split("/");
  if (parts.some((s) => s === ".." || s === "." || s === "")) return undefined;
  return parts.join("/");
}

/** `git@github.com:o/r.git` or `https://github.com/o/r(.git)` -> `https://github.com/o/r`. */
export function githubWebUrl(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const m = remote.trim().match(/^(?:git@github\.com:|https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : undefined;
}

// ---------------------------------------------------------------- release (hub latest.json + APK HEAD)

export type ReleaseData = {
  version: string;
  code: number;
  sha256: string;
  url: string;
  bytes?: number;
  package?: string;
  updatedAt?: string;
  commit?: string;
};

export function projectRelease(raw: unknown): ReleaseData | undefined {
  if (!record(raw)) return undefined;
  const version = text(raw.version);
  const code = num(raw.code);
  const sha256 = text(raw.sha256)?.toLowerCase();
  const url = httpsUrl(raw.url);
  if (!version || code === undefined || !sha256 || !/^[0-9a-f]{64}$/.test(sha256) || !url) return undefined;
  const updated = text(raw.updated_at);
  return {
    version,
    code,
    sha256,
    url,
    bytes: num(raw.bytes),
    package: text(raw.package),
    updatedAt: updated && Number.isFinite(Date.parse(updated)) ? updated : undefined,
    commit: text(raw.commit)?.slice(0, 12)
  };
}

export type ApkHead = { status: number; contentLength?: number; lastModified?: string };

/** What a HEAD of the APK says about the release: reachable, and the size latest.json promised. */
export function judgeApk(head: ApkHead, release: Pick<ReleaseData, "bytes">): { reachable: boolean; sizeMatches: boolean | null } {
  const reachable = head.status >= 200 && head.status < 300;
  return { reachable, sizeMatches: !reachable || release.bytes === undefined || head.contentLength === undefined ? null : head.contentLength === release.bytes };
}

// ---------------------------------------------------------------- storefront (anonymous GET)

export type StorefrontData = {
  status: number;
  hasBuyButton: boolean;
  checkoutUrl?: string;
  apkLinks: string[];
};

const decodeAttr = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export function analyzeStorefront(status: number, html: string): StorefrontData {
  const hrefs: string[] = [];
  for (const m of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) hrefs.push(decodeAttr(m[1] ?? m[2] ?? ""));
  const checkout = hrefs.find((h) => /^https:\/\/(buy|checkout)\.stripe\.com\//i.test(h));
  const apks = hrefs.filter((h) => /^https:\/\/.+\.apk(?:[?#].*)?$/i.test(h));
  return { status, hasBuyButton: checkout !== undefined, checkoutUrl: checkout, apkLinks: [...new Set(apks)] };
}

/** Does the page offer the very APK latest.json names? null when either side is unknown. */
export function apkLinkMatches(store: StorefrontData | undefined, release: ReleaseData | undefined): boolean | null {
  if (!store || !release) return null;
  const strip = (u: string) => u.split(/[?#]/)[0];
  return store.apkLinks.some((l) => strip(l) === strip(release.url));
}

// ---------------------------------------------------------------- sales (Stripe live, GET only)

export type SalesData = {
  /** Completed, paid Checkout Sessions of the payment link. */
  count: number;
  /** Gross by currency, in the currency's minor unit (cents). */
  gross: Record<string, number>;
  /** The headline currency and its gross, for one-number display. */
  currency?: string;
  grossMinor: number;
  firstSaleAt?: string;
  lastSaleAt?: string;
  refunds: { count: number; amountMinor: number };
  disputes: { count: number };
  truncated: boolean;
};

/** Only what the money summary needs; the caller projects Stripe rows down to this before anything else sees them. */
export type PaidSession = { createdAt: number; amountMinor: number; currency: string; paymentIntent?: string };

/** A Stripe Checkout Session list row -> a PaidSession, or undefined when it is not a completed paid sale. */
export function paidSession(raw: unknown): PaidSession | undefined {
  if (!record(raw)) return undefined;
  if (raw.status !== "complete" || raw.payment_status !== "paid") return undefined;
  const created = num(raw.created);
  const amount = num(raw.amount_total) ?? 0;
  const currency = text(raw.currency)?.toLowerCase();
  if (created === undefined || !currency) return undefined;
  const pi = typeof raw.payment_intent === "string" ? raw.payment_intent : record(raw.payment_intent) ? text(raw.payment_intent.id) : undefined;
  return { createdAt: created, amountMinor: amount, currency, paymentIntent: pi };
}

export type RefundRow = { paymentIntent?: string; amountMinor: number; status?: string };
export function refundRow(raw: unknown): RefundRow | undefined {
  if (!record(raw)) return undefined;
  const pi = typeof raw.payment_intent === "string" ? raw.payment_intent : undefined;
  return { paymentIntent: pi, amountMinor: num(raw.amount) ?? 0, status: text(raw.status) };
}
export function disputeRow(raw: unknown): { paymentIntent?: string } | undefined {
  if (!record(raw)) return undefined;
  return { paymentIntent: typeof raw.payment_intent === "string" ? raw.payment_intent : undefined };
}

export function summarizeSales(
  sales: PaidSession[],
  refunds: RefundRow[],
  disputes: Array<{ paymentIntent?: string }>,
  truncated = false
): SalesData {
  const gross: Record<string, number> = {};
  for (const s of sales) gross[s.currency] = (gross[s.currency] ?? 0) + s.amountMinor;
  const currency = Object.entries(gross).sort((a, b) => b[1] - a[1])[0]?.[0];
  const times = sales.map((s) => s.createdAt).sort((a, b) => a - b);
  const mine = new Set(sales.map((s) => s.paymentIntent).filter((p): p is string => !!p));
  const myRefunds = refunds.filter((r) => r.paymentIntent && mine.has(r.paymentIntent) && r.status !== "failed" && r.status !== "canceled");
  const myDisputes = disputes.filter((d) => d.paymentIntent && mine.has(d.paymentIntent));
  const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t * 1000).toISOString());
  return {
    count: sales.length,
    gross,
    currency,
    grossMinor: currency ? gross[currency] : 0,
    firstSaleAt: iso(times[0]),
    lastSaleAt: iso(times[times.length - 1]),
    refunds: { count: myRefunds.length, amountMinor: myRefunds.reduce((n, r) => n + r.amountMinor, 0) },
    disputes: { count: myDisputes.length },
    truncated
  };
}

/**
 * Strip anything key-shaped, and anything that names a buyer (an email, a Stripe object id), from an error
 * before it is reported to the browser. Errors come from Stripe, `op` and the issuer's stderr.
 */
export function scrubSecrets(message: string): string {
  return message
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[email]")
    .replace(/\b(?:cs|pi|cus|ch|re|dp|sub|in|py|pm|evt|plink)_(?:live_|test_)?[A-Za-z0-9]{14,}/g, "[id]")
    .replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9*_]+/g, "[key]")
    .replace(/\bops_[A-Za-z0-9_-]{8,}/g, "[token]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [token]")
    .slice(0, 300);
}

// ---------------------------------------------------------------- fulfilment (the issuer's `outstanding`)

export type FulfilmentData = {
  /** Paid, key not yet issued, still inside the promise. */
  due: number;
  /** Paid, key not yet issued, past the promise. */
  overdue: number;
  clear: number;
  blocked: number;
  /** Checkouts opened on the payment link but never paid (`not_issuable:not_paid`): nothing is owed. */
  unpaid: number;
  other: number;
  /** The soonest deadline among due keys, ISO. */
  soonestDueAt?: string;
  /** The longest overrun among overdue keys, in seconds. */
  worstOverdueSeconds?: number;
  /** Short machine words for blocked sessions (never free text). */
  blockedReasons: string[];
  promiseHours?: number;
};

/**
 * `outstanding` prints `{session: "paid_unissued:due_in=Ns" | "paid_unissued:overdue_by=Ns" | "clear:..." | "blocked:..." |
 * "not_issuable:<reason>"}`. `not_issuable:not_paid` is an open or abandoned checkout (nothing owed); any other
 * not_issuable reason is a session the issuer refuses, so it counts as blocked with that reason.
 * Session ids are Stripe ids: they are counted here and never returned.
 */
export function summarizeOutstanding(raw: unknown, nowMs: number, promiseHours?: number): FulfilmentData | undefined {
  if (!record(raw)) return undefined;
  const out: FulfilmentData = { due: 0, overdue: 0, clear: 0, blocked: 0, unpaid: 0, other: 0, blockedReasons: [], promiseHours };
  let soonest: number | undefined;
  let worst: number | undefined;
  for (const status of Object.values(raw)) {
    const s = typeof status === "string" ? status : "";
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^paid_unissued:due_in=(-?\d+)s?$/))) {
      out.due += 1;
      const secs = Math.max(0, Number(m[1]));
      soonest = soonest === undefined ? secs : Math.min(soonest, secs);
    } else if ((m = s.match(/^paid_unissued:overdue_by=(\d+)s?$/))) {
      out.overdue += 1;
      worst = Math.max(worst ?? 0, Number(m[1]));
    } else if (s.startsWith("clear:") || s === "clear") out.clear += 1;
    else if (s === "not_issuable:not_paid") out.unpaid += 1;
    else if (s.startsWith("blocked") || s.startsWith("not_issuable:")) {
      out.blocked += 1;
      const reason = s.slice(s.startsWith("blocked") ? "blocked".length : "not_issuable".length).replace(/^[:\s]+/, "").match(/^[a-z][a-z0-9_-]{0,39}/i)?.[0];
      if (reason && !out.blockedReasons.includes(reason)) out.blockedReasons.push(reason);
    } else out.other += 1;
  }
  if (soonest !== undefined) out.soonestDueAt = new Date(nowMs + soonest * 1000).toISOString();
  if (worst !== undefined) out.worstOverdueSeconds = worst;
  return out;
}

// ---------------------------------------------------------------- roll-up

export type SourceStatus = "ok" | "warn" | "down" | "unavailable";

/** The page's one urgency word for the money-owed state. */
export function fulfilmentUrgency(f: FulfilmentData | undefined): "overdue" | "owed" | "clear" | "unknown" {
  if (!f) return "unknown";
  if (f.overdue > 0) return "overdue";
  if (f.due > 0 || f.blocked > 0) return "owed";
  return "clear";
}

/** `~/x` in an argv element expands to the home directory; nothing else is interpreted (no shell is involved). */
export function expandArgv(argv: string[], home: string): string[] {
  return argv.map((a) => (a === "~" ? home : a.startsWith("~/") ? `${home}/${a.slice(2)}` : a));
}

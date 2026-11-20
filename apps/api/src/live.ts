import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { projectDefinition, projectLastRun, type LastRun } from "./candybar.js";
import type { ProjectRecord } from "./hub-model.js";
import {
  analyzeStorefront,
  apkLinkMatches,
  daysLive,
  disputeRow,
  expandArgv,
  fulfilmentUrgency,
  githubWebUrl,
  judgeApk,
  paidSession,
  parseLaunchFile,
  projectRelease,
  refundRow,
  safeRelPath,
  scrubSecrets,
  summarizeOutstanding,
  summarizeSales,
  type ApkHead,
  type FulfilmentData,
  type LiveDecl,
  type PaidSession,
  type ReleaseData,
  type SalesData,
  type SourceStatus,
  type StorefrontData
} from "./live-model.js";

// The Live hub: every registered pjangler project whose .launch.yaml says `mode: live`, with
// what is true about it right now. Read-only in every direction: it GETs, HEADs and runs the
// one read-only argv the live block declares. Nothing here writes to Stripe, the board, the
// issuer or Candybar.
//
// Each source is its own cached read with its own freshness and its own failure: a source
// that is down reports `down` (or `unavailable` with the reason) and the request still
// answers. Caches are in-process, TTL'd, refreshed on request (stale-while-revalidate, no
// timers); a cold read waits a bounded time and then reports `pending` instead of hanging.

const execFileAsync = promisify(execFile);

export type { SourceStatus };

export type LiveSource<T> = {
  status: SourceStatus | "pending";
  checkedAt?: string;
  ageSeconds?: number;
  /** Age past which the page should call this read stale. */
  maxSeconds: number;
  detail?: string;
  data?: T;
};

export type ReleaseView = ReleaseData & {
  apk: { status?: number; reachable: boolean; sizeMatches: boolean | null; contentLength?: number };
  packageMatches: boolean | null;
};
export type StorefrontView = StorefrontData & { apkMatchesRelease: boolean | null };
export type CandybarView = { name: string; enabled: boolean; schedule: string; lastRun?: LastRun | null };
export type ActivityView = { recent: Array<{ key: string; title: string; state?: string; updatedAt: string }> };
export type FulfilmentView = FulfilmentData & { urgency: "overdue" | "owed" | "clear" | "unknown" };

export type LiveApp = {
  id: string;
  name: string;
  tagline: string;
  platform: string;
  package: string;
  offer?: string;
  board: string;
  epic?: string;
  support?: string;
  declared?: string;
  liveSince: string;
  daysLive: number;
  /** The earliest promotion on the hub. Derived, never stored. */
  firstPromoted: boolean;
  storeUrl: string;
  links: {
    store: string;
    checkout?: string;
    board?: string;
    release: string;
    apk?: string;
    candybar?: string;
    evidence: Array<{ label: string; href: string }>;
  };
  sources: {
    release: LiveSource<ReleaseView>;
    storefront: LiveSource<StorefrontView>;
    sales: LiveSource<SalesData>;
    fulfilment: LiveSource<FulfilmentView>;
    reminder: LiveSource<CandybarView>;
    activity: LiveSource<ActivityView>;
  };
};

export type LiveSkipped = { id: string; name: string; problems: string[] };

export type LivePayload = {
  generatedAt: string;
  today: string;
  source: { name: string; down?: boolean; detail?: string };
  apps: LiveApp[];
  skipped: LiveSkipped[];
};

type Fetch = typeof fetch;
export type RunResult = { stdout: string };
export type RunFn = (file: string, args: string[], opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<RunResult>;
export type TicketRow = { key: string; title: string; state?: string; updatedAt: string };

export type LiveDeps = {
  fetch: Fetch;
  run: RunFn;
  now: () => number;
  /** utf8 text of a file, or undefined when it is not there. */
  readText: (path: string) => string | undefined;
  exists: (path: string) => boolean;
  projects: () => Promise<{ projects: ProjectRecord[]; down?: string }>;
  tickets: () => TicketRow[];
  candybarUrl: string;
  planeUrl: string;
  home: string;
  today: () => string;
  opBin: string;
  /** How long one request waits on a cold source before answering `pending`. */
  waitMs: number;
};

const TTL = { discovery: 15_000, release: 30_000, storefront: 60_000, sales: 120_000, fulfilment: 30_000, reminder: 30_000 } as const;
const HTTP_TIMEOUT_MS = 6_000;
const OUTSTANDING_TIMEOUT_MS = 25_000;
const OP_TIMEOUT_MS = 10_000;
const STRIPE_PAGES = 10;
const STRIPE_LIST_PAGES = 5;
const MIN_FORCE_AGE_MS = 3_000;

// ---------------------------------------------------------------- caching

type Hit<T> = { at: number; status: SourceStatus; detail?: string; data?: T };
type Probe<T> = { status: SourceStatus; detail?: string; data?: T };

class Memo {
  private hits = new Map<string, Hit<unknown>>();
  private inflight = new Map<string, Promise<Hit<unknown>>>();
  constructor(private deps: Pick<LiveDeps, "now" | "waitMs">) {}

  /**
   * Fresh hit: return it. Stale hit: return it and refresh behind the request. No hit: wait for the read, but at
   * most `waitMs`. A thrown read is a `down` hit (the error message, scrubbed), never an exception.
   */
  async get<T>(key: string, ttlMs: number, force: boolean, read: () => Promise<Probe<T>>): Promise<Hit<T> | undefined> {
    const now = this.deps.now();
    const hit = this.hits.get(key) as Hit<T> | undefined;
    const age = hit ? now - hit.at : Infinity;
    if (hit && age < ttlMs && !(force && age >= MIN_FORCE_AGE_MS)) return hit;
    let run = this.inflight.get(key) as Promise<Hit<T>> | undefined;
    if (!run) {
      run = (async () => {
        let result: Probe<T>;
        try {
          result = await read();
        } catch (error) {
          result = { status: "down", detail: scrubSecrets(error instanceof Error ? error.message : String(error)) };
        }
        const next: Hit<T> = { at: this.deps.now(), ...result };
        this.hits.set(key, next);
        return next;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, run);
    }
    if (hit && !force) return hit;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.deps.waitMs);
    });
    try {
      return (await Promise.race([run, wait])) ?? hit;
    } finally {
      clearTimeout(timer);
    }
  }

  clear() {
    this.hits.clear();
  }
}

function view<T>(hit: Hit<T> | undefined, maxMs: number, now: number): LiveSource<T> {
  const maxSeconds = Math.round((maxMs * 3) / 1000);
  if (!hit) return { status: "pending", maxSeconds, detail: "first read still running; it will be here on the next refresh" };
  return {
    status: hit.status,
    checkedAt: new Date(hit.at).toISOString(),
    ageSeconds: Math.max(0, Math.round((now - hit.at) / 1000)),
    maxSeconds,
    ...(hit.detail ? { detail: hit.detail } : {}),
    ...(hit.data !== undefined ? { data: hit.data } : {})
  };
}

// ---------------------------------------------------------------- readers

async function getText(deps: LiveDeps, url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const res = await deps.fetch(url, { redirect: "follow", ...init, signal: AbortSignal.timeout(init.timeoutMs ?? HTTP_TIMEOUT_MS) });
  return { res, body: init.method === "HEAD" ? "" : (await res.text()).slice(0, 1_500_000) };
}

async function readRelease(deps: LiveDeps, decl: LiveDecl): Promise<Probe<ReleaseView>> {
  const { res, body } = await getText(deps, decl.release, { headers: { accept: "application/json" } });
  if (!res.ok) return { status: "down", detail: `latest.json answered HTTP ${res.status}` };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { status: "down", detail: "latest.json is not JSON" };
  }
  const release = projectRelease(json);
  if (!release) return { status: "down", detail: "latest.json is missing version, code, sha256 or url" };
  const packageMatches = release.package === undefined ? null : release.package === decl.package;

  let head: ApkHead | undefined;
  let headError: string | undefined;
  try {
    const h = await deps.fetch(release.url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const len = Number(h.headers.get("content-length"));
    head = { status: h.status, contentLength: Number.isFinite(len) && h.headers.has("content-length") ? len : undefined, lastModified: h.headers.get("last-modified") ?? undefined };
  } catch (error) {
    headError = scrubSecrets(error instanceof Error ? error.message : String(error));
  }
  const apk = head ? judgeApk(head, release) : { reachable: false, sizeMatches: null };
  const data: ReleaseView = {
    ...release,
    apk: { status: head?.status, reachable: apk.reachable, sizeMatches: apk.sizeMatches, contentLength: head?.contentLength },
    packageMatches
  };
  if (!apk.reachable) return { status: "down", detail: headError ? `APK HEAD failed: ${headError}` : `APK answered HTTP ${head?.status}`, data };
  if (apk.sizeMatches === false) return { status: "warn", detail: "APK size differs from latest.json", data };
  if (packageMatches === false) return { status: "warn", detail: `latest.json is for ${release.package}, not ${decl.package}`, data };
  return { status: "ok", data };
}

async function readStorefront(deps: LiveDeps, decl: LiveDecl): Promise<Probe<StorefrontData>> {
  const { res, body } = await getText(deps, decl.storeUrl);
  const data = analyzeStorefront(res.status, res.ok ? body : "");
  if (!res.ok) return { status: "down", detail: `${decl.storeUrl} answered HTTP ${res.status}`, data };
  return { status: "ok", data };
}

/** The cached storefront read, judged against the current release (their freshness differs, so this runs per request). */
function judgeStorefront(sf: Hit<StorefrontData> | undefined, release: ReleaseData | undefined): Hit<StorefrontView> | undefined {
  if (!sf) return undefined;
  if (!sf.data) return { ...sf, data: undefined };
  const apkMatchesRelease = apkLinkMatches(sf.data, release);
  const data: StorefrontView = { ...sf.data, apkMatchesRelease };
  if (sf.status !== "ok") return { ...sf, data };
  if (!data.hasBuyButton) return { ...sf, status: "warn", detail: "no checkout link found on the page", data };
  if (apkMatchesRelease === false) return { ...sf, status: "warn", detail: "the page's APK link is not the current release", data };
  return { ...sf, data };
}

async function stripeGet(deps: LiveDeps, key: string, path: string, params: Record<string, string>): Promise<{ data: unknown[]; has_more: boolean }> {
  const qs = new URLSearchParams(params).toString();
  const res = await deps.fetch(`https://api.stripe.com${path}?${qs}`, {
    method: "GET",
    headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  const body = (await res.json().catch(() => undefined)) as { data?: unknown[]; has_more?: boolean; error?: { message?: string } } | undefined;
  if (!res.ok || !body || !Array.isArray(body.data)) {
    throw new Error(`Stripe ${path} answered HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`);
  }
  return { data: body.data, has_more: body.has_more === true };
}

async function stripeAll(deps: LiveDeps, key: string, path: string, params: Record<string, string>, pages: number) {
  const rows: unknown[] = [];
  let after: string | undefined;
  for (let i = 0; i < pages; i++) {
    const page = await stripeGet(deps, key, path, { limit: "100", ...params, ...(after ? { starting_after: after } : {}) });
    rows.push(...page.data);
    const last = page.data[page.data.length - 1] as { id?: unknown } | undefined;
    if (!page.has_more || typeof last?.id !== "string") return { rows, truncated: false };
    after = last.id;
  }
  return { rows, truncated: true };
}

async function readSales(deps: LiveDeps, decl: LiveDecl): Promise<Probe<SalesData>> {
  if (!decl.checkout) return { status: "unavailable", detail: "the live block declares no checkout" };
  if (decl.checkout.provider !== "stripe") return { status: "unavailable", detail: `sales are only read for stripe, not ${decl.checkout.provider}` };
  let key: string;
  try {
    const out = await deps.run(deps.opBin, ["read", "--no-newline", decl.checkout.keyRef], { timeoutMs: OP_TIMEOUT_MS });
    key = out.stdout.trim();
    if (!key) throw new Error("empty value");
  } catch (error) {
    return { status: "unavailable", detail: `the Stripe key could not be read from 1Password: ${scrubSecrets(cliReason(error))}` };
  }
  // GET only: the sessions of this payment link, then (only if there were sales) the account's refunds and disputes.
  const sessions = await stripeAll(deps, key, "/v1/checkout/sessions", { payment_link: decl.checkout.paymentLink }, STRIPE_PAGES);
  const paid = sessions.rows.map(paidSession).filter((s): s is PaidSession => !!s);
  let refunds: ReturnType<typeof refundRow>[] = [];
  let disputes: ReturnType<typeof disputeRow>[] = [];
  let truncated = sessions.truncated;
  if (paid.length) {
    const [r, d] = await Promise.all([
      stripeAll(deps, key, "/v1/refunds", {}, STRIPE_LIST_PAGES),
      stripeAll(deps, key, "/v1/disputes", {}, STRIPE_LIST_PAGES)
    ]);
    refunds = r.rows.map(refundRow);
    disputes = d.rows.map(disputeRow);
    truncated = truncated || r.truncated || d.truncated;
  }
  const data = summarizeSales(
    paid,
    refunds.filter((x): x is NonNullable<typeof x> => !!x),
    disputes.filter((x): x is NonNullable<typeof x> => !!x),
    truncated
  );
  if (data.disputes.count > 0) return { status: "warn", detail: `${data.disputes.count} dispute(s) open on this link's sales`, data };
  if (truncated) return { status: "warn", detail: "more sales than one read covers; counts are a floor", data };
  return { status: "ok", data };
}

function cliReason(error: unknown): string {
  const e = error as { killed?: boolean; code?: unknown; stderr?: unknown; message?: string };
  if (e?.killed) return "timed out";
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim().split("\n")[0] : "";
  return stderr || (typeof e?.code === "string" ? e.code : e?.message) || "failed";
}

async function readFulfilment(deps: LiveDeps, decl: LiveDecl, repoPath: string): Promise<Probe<FulfilmentView>> {
  const f = decl.fulfilment;
  if (!f) return { status: "unavailable", detail: "the live block declares no fulfilment" };
  const [file, ...args] = expandArgv(f.outstandingArgv, deps.home);
  let out: RunResult;
  try {
    out = await deps.run(file, args, { cwd: repoPath, timeoutMs: OUTSTANDING_TIMEOUT_MS, env: { ...process.env, TMPDIR: "/tmp" } });
  } catch (error) {
    return { status: "down", detail: `outstanding failed: ${scrubSecrets(cliReason(error))}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(out.stdout.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? out.stdout);
  } catch {
    return { status: "down", detail: "outstanding did not print JSON" };
  }
  const data = summarizeOutstanding(json, deps.now(), f.promiseHours);
  if (!data) return { status: "down", detail: "outstanding did not print a JSON object" };
  const view: FulfilmentView = { ...data, urgency: fulfilmentUrgency(data) };
  if (data.blocked > 0) return { status: "warn", detail: `${data.blocked} blocked${data.blockedReasons.length ? ` (${data.blockedReasons.join(", ")})` : ""}`, data: view };
  if (data.other > 0) return { status: "warn", detail: `${data.other} session(s) in a state this hub does not know`, data: view };
  return { status: "ok", data: view };
}

async function readReminder(deps: LiveDeps, decl: LiveDecl, list: () => Promise<Probe<Array<{ id: string; name: string; enabled: boolean; schedule: string }>>>): Promise<Probe<CandybarView>> {
  const want = decl.fulfilment?.reminderCandybar;
  if (!want) return { status: "unavailable", detail: "the live block names no reminder candybar" };
  const all = await list();
  if (!all.data) return { status: "down", detail: all.detail ?? "Candybar is not answering" };
  const row = all.data.find((c) => c.id === want || c.name === want);
  if (!row) return { status: "down", detail: `${want} is not registered on Candybar` };
  let lastRun: LastRun | null | undefined;
  let runError: string | undefined;
  try {
    const { res, body } = await getText(deps, `${deps.candybarUrl}/candybars/${encodeURIComponent(row.id)}/invocations?limit=1`, { headers: { accept: "application/json" } });
    if (!res.ok) runError = `invocations answered HTTP ${res.status}`;
    else lastRun = projectLastRun(JSON.parse(body));
  } catch (error) {
    runError = scrubSecrets(error instanceof Error ? error.message : String(error));
  }
  const data: CandybarView = { name: row.name, enabled: row.enabled, schedule: row.schedule, lastRun };
  if (!row.enabled) return { status: "warn", detail: "the reminder is registered but disabled", data };
  if (runError) return { status: "warn", detail: `last run unreadable: ${runError}`, data };
  if (lastRun === null) return { status: "warn", detail: "the reminder has not run yet", data };
  if (lastRun?.result === "fail") return { status: "warn", detail: "the last reminder run failed", data };
  return { status: "ok", data };
}

async function readCandybarList(deps: LiveDeps): Promise<Probe<Array<{ id: string; name: string; enabled: boolean; schedule: string }>>> {
  const { res, body } = await getText(deps, `${deps.candybarUrl}/candybars`, { headers: { accept: "application/json" } });
  if (!res.ok) return { status: "down", detail: `Candybar answered HTTP ${res.status}` };
  const raw = JSON.parse(body) as unknown;
  if (!Array.isArray(raw)) return { status: "down", detail: "GET /candybars did not return a list" };
  const rows = raw.map(projectDefinition).filter((d): d is NonNullable<typeof d> => !!d).map((d) => ({ id: d.id, name: d.name, enabled: d.enabled, schedule: d.schedule }));
  return { status: "ok", data: rows };
}

// ---------------------------------------------------------------- discovery

type Found = { project: ProjectRecord; repoPath: string; decl: LiveDecl };

function repoRemote(deps: LiveDeps, repoPath: string): string | undefined {
  const cfg = deps.readText(join(repoPath, ".git", "config"));
  return cfg?.match(/\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/)?.[1];
}

function evidenceLinks(deps: LiveDeps, repoPath: string, decl: LiveDecl): Array<{ label: string; href: string }> {
  const gh = githubWebUrl(repoRemote(deps, repoPath));
  if (!gh) return [];
  const out: Array<{ label: string; href: string }> = [];
  const seen = new Set<string>();
  const add = (rel: string | undefined, label?: string) => {
    const p = rel ? safeRelPath(rel) : undefined;
    if (!p || seen.has(p) || !deps.exists(join(repoPath, p))) return;
    seen.add(p);
    out.push({ label: label ?? basename(p).replace(/\.[^.]+$/, ""), href: `${gh}/blob/main/${p.split("/").map(encodeURIComponent).join("/")}` });
  };
  add("docs/runbook.md", "runbook");
  for (const c of decl.contract) add(c);
  return out;
}

// ---------------------------------------------------------------- the hub

export function createLiveHub(deps: LiveDeps) {
  const memo = new Memo(deps);

  async function discover(force: boolean) {
    const hit = await memo.get<{ found: Found[]; skipped: LiveSkipped[]; down?: string }>("discovery", TTL.discovery, force, async () => {
      const { projects, down } = await deps.projects();
      const found: Found[] = [];
      const skipped: LiveSkipped[] = [];
      const seen = new Set<string>();
      for (const project of projects) {
        const dir = project.repoPath;
        if (!dir) continue;
        let real = dir;
        try {
          real = realpathSync(dir);
        } catch {
          // a registered path that is gone has no launch file to read
        }
        if (seen.has(real)) continue;
        const read = parseLaunchFile(deps.readText(join(dir, ".launch.yaml")));
        if (read.kind === "live") {
          seen.add(real);
          found.push({ project, repoPath: dir, decl: read.decl });
        } else if (read.kind === "invalid") {
          seen.add(real);
          skipped.push({ id: project.id, name: project.name, problems: read.problems });
        }
      }
      return { status: (down ? "warn" : "ok") as SourceStatus, detail: down, data: { found, skipped, down } };
    });
    return hit?.data ?? { found: [], skipped: [], down: hit?.detail ?? "discovery is still reading" };
  }

  async function sources(f: Found, force: boolean): Promise<LiveApp["sources"]> {
    const { decl, repoPath, project } = f;
    const id = project.id;
    const now = deps.now();
    const release = await memo.get<ReleaseView>(`${id}:release`, TTL.release, force, () => readRelease(deps, decl));
    const [storefrontRaw, sales, fulfilment, reminder] = await Promise.all([
      memo.get<StorefrontData>(`${id}:storefront`, TTL.storefront, force, () => readStorefront(deps, decl)),
      memo.get<SalesData>(`${id}:sales`, TTL.sales, force, () => readSales(deps, decl)),
      memo.get<FulfilmentView>(`${id}:fulfilment`, TTL.fulfilment, force, () => readFulfilment(deps, decl, repoPath)),
      memo.get<CandybarView>(`${id}:reminder`, TTL.reminder, force, () =>
        readReminder(deps, decl, async () => {
          const l = await memo.get<Array<{ id: string; name: string; enabled: boolean; schedule: string }>>("candybars", TTL.reminder, force, () => readCandybarList(deps));
          return l ? { status: l.status, detail: l.detail, data: l.data } : { status: "down", detail: "Candybar read is still running" };
        })
      )
    ]);
    const storefront = judgeStorefront(storefrontRaw, release?.data);
    const prefix = `${decl.board}-`;
    const recent = deps
      .tickets()
      .filter((t) => t.key.startsWith(prefix))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 6);
    const activity: Hit<ActivityView> = { at: now, status: "ok", data: { recent }, ...(recent.length ? {} : { detail: "no board events collected yet" }) };
    return {
      release: view(release, TTL.release, now),
      storefront: view(storefront, TTL.storefront, now),
      sales: view(sales, TTL.sales, now),
      fulfilment: view(fulfilment, TTL.fulfilment, now),
      reminder: view(reminder, TTL.reminder, now),
      activity: { ...view(activity, 60_000, now), maxSeconds: 3600 }
    };
  }

  async function read(opts: { force?: boolean } = {}): Promise<LivePayload> {
    const force = opts.force === true;
    const d = await discover(force);
    const today = deps.today();
    const ordered = [...d.found].sort((a, b) => a.decl.liveSince.localeCompare(b.decl.liveSince) || a.decl.name.localeCompare(b.decl.name));
    const apps = await Promise.all(
      ordered.map(async (f, index): Promise<LiveApp> => {
        const s = await sources(f, force);
        const { decl, project } = f;
        const board = project.boardId && project.workspace ? `${deps.planeUrl}/${project.workspace}/projects/${project.boardId}/issues/` : undefined;
        return {
          id: project.id,
          name: decl.name,
          tagline: decl.tagline,
          platform: decl.platform,
          package: decl.package,
          offer: decl.offer,
          board: decl.board,
          epic: decl.epic,
          support: decl.support,
          declared: decl.declared,
          liveSince: decl.liveSince,
          daysLive: daysLive(decl.liveSince, today),
          firstPromoted: index === 0,
          storeUrl: decl.storeUrl,
          links: {
            store: decl.storeUrl,
            checkout: s.storefront.data?.checkoutUrl,
            board,
            release: decl.release,
            apk: s.release.data?.url,
            candybar: decl.fulfilment?.reminderCandybar ? "/candybar" : undefined,
            evidence: evidenceLinks(deps, f.repoPath, decl)
          },
          sources: s
        };
      })
    );
    return {
      generatedAt: new Date(deps.now()).toISOString(),
      today,
      source: { name: "pjangler", ...(d.down ? { down: true, detail: d.down } : {}) },
      apps,
      skipped: d.skipped
    };
  }

  return { read, reset: () => memo.clear() };
}

// ---------------------------------------------------------------- wiring

const run: RunFn = async (file, args, opts) => {
  const { stdout } = await execFileAsync(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs, env: opts.env, maxBuffer: 2_000_000, encoding: "utf8" });
  return { stdout };
};

export function defaultLiveDeps(sources: { projects: LiveDeps["projects"]; tickets: LiveDeps["tickets"] }): LiveDeps {
  return {
    fetch,
    run,
    now: Date.now,
    readText: (p) => {
      try {
        return existsSync(p) ? readFileSync(p, "utf8") : undefined;
      } catch {
        return undefined;
      }
    },
    exists: existsSync,
    projects: sources.projects,
    tickets: sources.tickets,
    candybarUrl: (process.env.CANDYBAR_API_URL ?? "https://candybar.delo.sh").replace(/\/$/, ""),
    planeUrl: (process.env.PLANE_URL ?? "https://plane.delo.sh").replace(/\/$/, ""),
    home: homedir(),
    today: () => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()),
    opBin: process.env.LIVE_OP_BIN ?? "op",
    waitMs: 8_000
  };
}

export function registerLiveRoutes(app: FastifyInstance, hub: ReturnType<typeof createLiveHub>) {
  app.get<{ Querystring: { force?: string } }>("/api/modules/live/apps", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return hub.read({ force: req.query.force === "1" });
  });
}

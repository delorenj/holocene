import type { FastifyInstance, FastifyReply } from "fastify";
import type { EventCollector } from "./event-collector.js";
import { opRead, type Secrets } from "./avatars.js";
import { sendEvent, streamHeaders } from "./event-stream.js";
import {
  GENESIS_OPERATOR_BASE,
  GENESIS_PREFIX,
  alertIdOf,
  deriveAlerts,
  deriveApprovals,
  genesisOverview,
  toGenesisEvents,
  type AlertAck,
  type ApprovalState,
} from "./genesis.js";

// The Genesis tab. Reads every bloodbank.genesis.* fact from the shared collection (a type-prefix range, so a new
// Genesis event type shows up without a code change) and projects it into "Needs you" plus a timeline. Three actions
// reach Genesis's operator API server-side with the operator token (1Password, read per process and cached in
// memory; the browser never holds it): reply to a client through their assistant, refresh a client's proposals,
// and acknowledge an alert. Only the client's own session can approve or decline an approval, so nothing here can.

const TOKEN_REF = process.env.GENESIS_OPERATOR_TOKEN_REF ?? "op://DeLoSecrets/kjomkcir4gjscjk4mypjpacyxm/password";
/** Genesis's operator acknowledgement route, `{id}` replaced; empty disables the upstream call (local only). */
const ACK_PATH = process.env.GENESIS_ALERT_ACK_PATH ?? "/api/operator/escalations/{id}/ack";
/** How many Genesis facts the projections read. Approvals and alerts older than this window drop out. */
const WINDOW = 2000;
const TIMEOUT_MS = 20_000;
const COALESCE_MS = 250;
// Leading alphanumeric: never a "." or ".." path segment in the Genesis URL these ids are spliced into.
const ID = "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$";

type Json = Record<string, unknown>;
const record = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

export type GenesisDeps = {
  secrets?: Secrets;
  http?: typeof fetch;
  baseUrl?: string;
  tokenRef?: string;
  ackPath?: string;
  now?: () => number;
  coalesceMs?: number;
};

type Sent = { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string; body?: unknown };

/** Genesis's operator API with the operator bearer token. A 401 rereads the token once (it may have been rotated). */
export class GenesisOperatorClient {
  private token?: string;
  constructor(private deps: Required<Pick<GenesisDeps, "secrets" | "http" | "baseUrl" | "tokenRef">>) {}

  async call(method: "GET" | "POST", path: string, payload?: unknown): Promise<Sent> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.token ??= await this.deps.secrets(this.deps.tokenRef);
      if (!this.token) return { ok: false, status: 503, error: "The Genesis operator token could not be read from 1Password." };
      let response: Response;
      try {
        response = await this.deps.http(`${this.deps.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/json",
            ...(payload === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "Error";
        return { ok: false, status: 502, error: `Genesis did not answer (${name === "TimeoutError" ? `no reply in ${TIMEOUT_MS / 1000}s` : name}).` };
      }
      if (response.status === 401 && attempt === 0) {
        this.token = undefined;
        continue;
      }
      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      if (!response.ok) {
        const code = record(body) && typeof body.error === "string" ? body.error.slice(0, 200) : `HTTP ${response.status}`;
        return { ok: false, status: response.status, error: code, body };
      }
      return { ok: true, status: response.status, body };
    }
    return { ok: false, status: 401, error: "Genesis refused the operator token." };
  }
}

/** The operator's view of a client's proposals, minus digests and signature hashes. */
const PROPOSAL_FIELDS = ["id", "kind", "to", "subject", "body", "why", "status", "created", "expires", "decided", "edited",
  "edited_at", "channel", "error", "notified", "tool_call_id", "mailbox", "original"] as const;
export function projectProposals(body: unknown): Json[] {
  const list = record(body) && Array.isArray(body.proposals) ? body.proposals : [];
  return list.filter(record).map((p) => Object.fromEntries(PROPOSAL_FIELDS.filter((k) => k in p).map((k) => [k, p[k]])));
}

/** Holocene's own record that the operator acknowledged an alert (kept beside the collection; survives compaction). */
export class AlertAcks {
  constructor(private db: EventCollector["store"]["db"]) {
    db.exec(`CREATE TABLE IF NOT EXISTS genesis_alert_acks (
      alert_id TEXT PRIMARY KEY, acked_at TEXT NOT NULL, upstream TEXT, upstream_detail TEXT)`);
  }
  all(): Map<string, AlertAck> {
    const rows = this.db.prepare("SELECT alert_id,acked_at,upstream FROM genesis_alert_acks").all();
    return new Map(rows.map((r) => [String(r.alert_id), { at: String(r.acked_at), via: "holocene" as const, upstream: r.upstream === null ? null : String(r.upstream) }]));
  }
  put(alertId: string, at: string, upstream: string, detail: string | null) {
    this.db.prepare(`INSERT INTO genesis_alert_acks VALUES (?,?,?,?) ON CONFLICT(alert_id) DO UPDATE SET
      upstream=excluded.upstream, upstream_detail=excluded.upstream_detail`).run(alertId, at, upstream, detail);
  }
}

export function registerGenesisRoutes(app: FastifyInstance, collector: EventCollector, deps: GenesisDeps = {}) {
  const store = collector.store;
  const now = deps.now ?? Date.now;
  const coalesceMs = deps.coalesceMs ?? COALESCE_MS;
  const genesis = new GenesisOperatorClient({
    secrets: deps.secrets ?? opRead,
    http: deps.http ?? fetch,
    baseUrl: (deps.baseUrl ?? GENESIS_OPERATOR_BASE).replace(/\/$/, ""),
    tokenRef: deps.tokenRef ?? TOKEN_REF,
  });
  const ackPath = deps.ackPath ?? ACK_PATH;
  const acks = new AlertAcks(store.db);
  // Bumped by a local write (an acknowledgement) so open streams resend even though no new fact arrived.
  let localVersion = 0;
  const localListeners = new Set<() => void>();
  const touched = () => {
    localVersion++;
    for (const listener of localListeners) listener();
  };

  const source = () => {
    const s = collector.status();
    return { state: s.state, lastEventAt: s.last_event_at, catchingUp: s.catching_up, error: s.error };
  };
  const facts = (limit = WINDOW) => toGenesisEvents(store.byTypePrefix(GENESIS_PREFIX, { limit }));
  const overview = (timeline = 200) => ({ ...genesisOverview(facts(), acks.all(), now(), timeline), source: source() });

  app.get<{ Querystring: { limit?: number } }>("/api/modules/genesis/overview", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 1000 } } } },
  }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return overview(req.query.limit ?? 200);
  });

  app.get<{ Querystring: { limit?: number; before?: number; type?: string } }>("/api/modules/genesis/events", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: {
      limit: { type: "integer", minimum: 1, maximum: 500 },
      before: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      type: { type: "string", pattern: "^bloodbank\\.genesis\\.[a-z0-9_.]{1,120}$" },
    } } },
  }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const limit = req.query.limit ?? 100;
    // A type narrows the prefix itself, so it still walks the index (bloodbank.genesis.approval. covers every approval fact).
    const prefix = req.query.type ?? GENESIS_PREFIX;
    const items = toGenesisEvents(store.byTypePrefix(prefix, { limit, before: req.query.before }));
    return {
      generated_at: new Date(now()).toISOString(),
      source: source(),
      prefix,
      items,
      next_before: items.length === limit ? items.at(-1)!.cursor : null,
    };
  });

  app.get<{ Querystring: { state?: ApprovalState } }>("/api/modules/genesis/approvals", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: {
      state: { type: "string", enum: ["pending", "approved", "declined", "expired", "lapsed"] },
    } } },
  }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const all = deriveApprovals(toGenesisEvents(store.byTypePrefix(`${GENESIS_PREFIX}approval.`, { limit: WINDOW })), now());
    return { generated_at: new Date(now()).toISOString(), source: source(), approvals: req.query.state ? all.filter((a) => a.state === req.query.state) : all };
  });

  app.get<{ Querystring: { open?: boolean } }>("/api/modules/genesis/alerts", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: { open: { type: "boolean" } } } },
  }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const all = deriveAlerts(toGenesisEvents(store.byTypePrefix(`${GENESIS_PREFIX}alert.`, { limit: WINDOW })), acks.all());
    return { generated_at: new Date(now()).toISOString(), source: source(), alerts: req.query.open ? all.filter((a) => !a.acknowledged) : all };
  });

  // ---- actions (server-side, operator token) ----

  const clientParams = { type: "object", required: ["clientId"], properties: { clientId: { type: "string", pattern: ID } } };
  const refused = (reply: FastifyReply, r: Extract<Sent, { ok: false }>) =>
    reply.status(r.status >= 400 && r.status < 600 ? r.status : 502).send({ error: r.error });

  // Client-visible: the assistant relays it to the client. The page confirms first; `confirmed: true` is required here
  // too so a stray call cannot speak to a client.
  app.post<{ Params: { clientId: string }; Body: { message: string; confirmed: boolean } }>("/api/modules/genesis/clients/:clientId/reply", {
    schema: {
      params: clientParams,
      body: { type: "object", additionalProperties: false, required: ["message", "confirmed"], properties: {
        message: { type: "string", minLength: 1, maxLength: 4000 },
        confirmed: { type: "boolean", const: true },
      } },
    },
  }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const message = req.body.message.trim();
    if (!message) return reply.status(400).send({ error: "The reply is empty." });
    const r = await genesis.call("POST", `/api/operator/clients/${encodeURIComponent(req.params.clientId)}/chat`, { message });
    if (!r.ok) return refused(reply, r);
    const messages = record(r.body) && Array.isArray(r.body.messages) ? r.body.messages.filter(record) : [];
    const sent = [...messages].reverse().find((m) => m.source === "operator" && m.content === message);
    req.log.info({ genesis_client: req.params.clientId }, "Genesis operator reply delivered");
    return { ok: true, client_id: req.params.clientId, message_id: sent?.id ?? null, sent_at: sent?.created ?? new Date(now()).toISOString() };
  });

  app.get<{ Params: { clientId: string } }>("/api/modules/genesis/clients/:clientId/proposals", {
    schema: { params: clientParams },
  }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    // Reading proposals is also what makes Genesis expire overdue ones (it has no clock of its own).
    const r = await genesis.call("GET", `/api/operator/clients/${encodeURIComponent(req.params.clientId)}/proposals`);
    if (!r.ok) return refused(reply, r);
    return { client_id: req.params.clientId, fetched_at: new Date(now()).toISOString(), proposals: projectProposals(r.body) };
  });

  app.post<{ Params: { alertId: string } }>("/api/modules/genesis/alerts/:alertId/ack", {
    schema: { params: { type: "object", required: ["alertId"], properties: { alertId: { type: "string", pattern: ID } } } },
  }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const alertId = req.params.alertId;
    const known = toGenesisEvents(store.byTypePrefix(`${GENESIS_PREFIX}alert.`, { limit: WINDOW }))
      .some((e) => e.action === "raised" && alertIdOf(e) === alertId);
    if (!known) return reply.status(404).send({ error: "No bloodbank.genesis.alert.raised with that alert id is in the collection." });
    let upstream = "disabled", detail: string | null = null;
    if (ackPath) {
      const r = await genesis.call("POST", ackPath.replace("{id}", encodeURIComponent(alertId)), {});
      if (r.ok) upstream = "acknowledged";
      else if (r.status === 404 || r.status === 405) (upstream = "not_available", detail = r.error);
      else (upstream = "failed", detail = r.error);
    }
    const at = new Date(now()).toISOString();
    acks.put(alertId, at, upstream, detail);
    touched();
    return {
      ok: true,
      alert_id: alertId,
      acknowledged_at: acks.all().get(alertId)?.at ?? at,
      upstream,
      note: upstream === "acknowledged" ? "Recorded in Holocene and in Genesis."
        : "Recorded in Holocene only: Genesis did not record the acknowledgement" + (detail ? ` (${detail}).` : "."),
    };
  });

  // ---- live updates ----

  const streams = new Set<() => void>();
  app.addHook("preClose", async () => { for (const close of streams) close(); });
  app.get("/api/modules/genesis/stream", { sse: "only" }, async (_req, reply) => {
    streamHeaders(reply);
    let closed = false, pumping = false, dirty = true, force = true;
    let sentCursor = -1, sentLocal = -1;
    let queued: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      dirty = true;
      if (!queued && !pumping && !closed) queued = setTimeout(() => { queued = undefined; void pump(); }, coalesceMs);
    };
    // The collector signals every committed change without its type; coalesce, then check the Genesis range only.
    const unsubscribe = collector.subscribe((change) => { if (change.kind === "event") schedule(); });
    const onLocal = () => { force = true; schedule(); };
    localListeners.add(onLocal);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(queued);
      unsubscribe();
      localListeners.delete(onLocal);
      streams.delete(close);
    };
    const close = () => { cleanup(); reply.sse.close(); };
    reply.sse.onClose(cleanup);
    reply.sse.keepAlive();
    streams.add(close);
    async function pump() {
      if (closed || pumping) return;
      pumping = true;
      try {
        // A change that lands while a frame is being written is picked up by the next pass, not dropped.
        while (dirty && !closed) {
          dirty = false;
          const head = store.latestCursorWithPrefix(GENESIS_PREFIX);
          if (!force && head === sentCursor && localVersion === sentLocal) continue;
          force = false;
          sentCursor = head;
          sentLocal = localVersion;
          await sendEvent(reply, { event: "overview", id: String(head), data: overview() });
        }
      } catch { close(); }
      finally { pumping = false; }
    }
    await pump();
  });
}

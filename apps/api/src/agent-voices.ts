// The voice each agent speaks, read and assigned from the Agents page.
//
// Holocene does not own agent voices. Flume does: the desk's config.delta.yaml pin (else the fleet base
// tts.vox.voice) is the single source of truth, and `flume identity voice` is the one supported reader and writer
// (FLUME voice.ts, HOLOC-54). This module is a thin, typed bridge to that command so every agent on the canvas
// (directors, PMs, specialists) gets the same picker, and any other Holocene surface that wants to change a voice
// calls these routes instead of writing a tile, a flag file or a rendered profile itself.
//
//   GET /api/modules/hub/voices                    the Vox catalog the picker offers
//   GET /api/modules/hub/agents/:agentId/voice     what the agent speaks now (pinned or fleet default)
//   PUT /api/modules/hub/agents/:agentId/voice     {voice: "<slug>"} pins a Vox voice, {voice: null} inherits again
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";

const execFileAsync = promisify(execFile);

/** Same shape Flume enforces for desk ids and voice slugs (voice.ts VOICE_SLUG). */
export const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CATALOG_TTL_MS = 60_000;
/** After a failed refresh, serve the last good list this long before asking Vox again. */
const CATALOG_RETRY_MS = 15_000;

export type VoiceOption = { name: string; displayName: string; tags: string[]; persona?: string };
export type VoiceCatalog = { voices: VoiceOption[]; fetchedAt: string; source: string; stale?: boolean };

export type AgentVoice = {
  ok: boolean;
  agentId: string;
  profile: string | null;
  /** The voice the agent speaks now, read back from its rendered profile. */
  voice: string | null;
  source: "pinned" | "fleet default" | "none";
  fleetDefault: string | null;
  changed: boolean;
  blockers: Array<{ code: string; detail: string }>;
  detail: string;
  /** Present after a write: whether the running desk picked the new voice up. */
  gateway?: { action: string; confirmed: boolean; detail: string };
};

export type FlumeRun = { code: number; stdout: string; stderr: string };

export type VoiceDeps = {
  runFlume: (args: string[]) => Promise<FlumeRun>;
  fetchCatalog: () => Promise<VoiceOption[]>;
  now: () => number;
};

export function defaultVoiceDeps(): VoiceDeps {
  const flume = process.env.FLUME_BIN ?? "flume";
  const vox = (process.env.VOX_URL ?? "https://vox.delo.sh").replace(/\/+$/u, "");
  return {
    async runFlume(args) {
      try {
        const { stdout, stderr } = await execFileAsync(flume, args, { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
        return { code: 0, stdout, stderr };
      } catch (e) {
        // Flume exits non-zero on a refusal but still prints its JSON report on stdout.
        const err = e as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
        if (typeof err.stdout === "string" && err.stdout.trim()) return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout, stderr: err.stderr ?? "" };
        throw new Error(`could not run ${flume}: ${err.message}`);
      }
    },
    async fetchCatalog() {
      const res = await fetch(`${vox}/voices`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Vox answered HTTP ${res.status} for ${vox}/voices`);
      return parseCatalog(await res.json());
    },
    now: () => Date.now()
  };
}

/** Vox's /voices rows, trimmed to what a picker needs and sorted by display name. */
export function parseCatalog(body: unknown): VoiceOption[] {
  const rows = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { voices?: unknown }).voices) ? (body as { voices: unknown[] }).voices : [];
  const out: VoiceOption[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name || !SLUG.test(name) || seen.has(name)) continue;
    seen.add(name);
    const displayName = typeof r.display_name === "string" && r.display_name.trim() ? r.display_name.trim() : name;
    const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [];
    const persona = typeof r.persona === "string" && r.persona.trim() ? r.persona.trim() : undefined;
    out.push({ name, displayName, tags, ...(persona ? { persona } : {}) });
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.name.localeCompare(b.name));
}

/** Flume's VoiceResult JSON → the route's shape. Anything unparseable is a failed read, never a guess. */
export function parseFlumeVoice(agentId: string, run: FlumeRun): AgentVoice {
  let doc: Record<string, any>;
  try {
    doc = JSON.parse(run.stdout);
  } catch {
    const tail = (run.stderr || run.stdout).trim().split("\n").slice(-2).join(" ");
    return { ok: false, agentId, profile: null, voice: null, source: "none", fleetDefault: null, changed: false, blockers: [{ code: "flume-output", detail: `flume printed no JSON report (exit ${run.code})${tail ? `: ${tail}` : ""}` }], detail: "unreadable flume report" };
  }
  const speaks = doc.speaks && typeof doc.speaks === "object" ? doc.speaks : {};
  const source = speaks.source === "pinned" || speaks.source === "fleet default" ? speaks.source : "none";
  const blockers = Array.isArray(doc.blockers) ? doc.blockers.filter((b: any) => b && typeof b.code === "string").map((b: any) => ({ code: String(b.code), detail: String(b.detail ?? "") })) : [];
  const out: AgentVoice = {
    ok: doc.ok === true && run.code === 0,
    agentId,
    profile: typeof doc.profile === "string" ? doc.profile : null,
    voice: typeof speaks.voice === "string" ? speaks.voice : null,
    source,
    fleetDefault: typeof doc.fleet_default === "string" ? doc.fleet_default : null,
    changed: doc.changed === true,
    blockers,
    // A flume that threw prints only {ok:false, error}: keep its message rather than a bare exit code.
    detail: typeof doc.detail === "string" && doc.detail ? doc.detail : typeof doc.error === "string" ? doc.error : ""
  };
  if (doc.gateway && typeof doc.gateway === "object") out.gateway = { action: String(doc.gateway.action ?? ""), confirmed: doc.gateway.confirmed === true, detail: String(doc.gateway.detail ?? "") };
  if (!out.ok && !out.blockers.length) out.blockers.push({ code: "flume-failed", detail: out.detail || `flume exited ${run.code}` });
  return out;
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export function createAgentVoices(deps: VoiceDeps) {
  let cached: VoiceCatalog | undefined;
  let cachedAt = 0;
  let failedAt = -Infinity;
  let inflight: Promise<VoiceCatalog> | undefined;
  // One write at a time: each one rewrites a desk's delta and rendered config and may cycle it through the gateway.
  let writes: Promise<unknown> = Promise.resolve();

  async function catalog(force = false): Promise<VoiceCatalog> {
    if (!force && cached && deps.now() - cachedAt < CATALOG_TTL_MS) return cached;
    if (!force && cached && deps.now() - failedAt < CATALOG_RETRY_MS) return { ...cached, stale: true };
    inflight ??= (async () => {
      try {
        const voices = await deps.fetchCatalog();
        cached = { voices, fetchedAt: new Date(deps.now()).toISOString(), source: "vox" };
        cachedAt = deps.now();
        return cached;
      } finally {
        inflight = undefined;
      }
    })();
    try {
      return await inflight;
    } catch (e) {
      failedAt = deps.now();
      if (cached) return { ...cached, stale: true }; // Vox blipped: keep offering the last good list
      throw e;
    }
  }

  async function read(agentId: string): Promise<AgentVoice> {
    if (!SLUG.test(agentId)) throw new HttpError(400, `agent id "${agentId}" is not a desk id`);
    return parseFlumeVoice(agentId, await deps.runFlume(["identity", "voice", agentId, "--json"]));
  }

  async function assign(agentId: string, voice: string | null): Promise<AgentVoice> {
    if (!SLUG.test(agentId)) throw new HttpError(400, `agent id "${agentId}" is not a desk id`);
    if (voice !== null && !SLUG.test(voice)) throw new HttpError(400, `voice "${voice}" is not a Vox voice slug`);
    const args = ["identity", "voice", agentId, ...(voice === null ? ["--clear"] : ["--assign", voice]), "--apply", "--json"];
    const run = writes.then(() => deps.runFlume(args));
    writes = run.catch(() => undefined);
    return parseFlumeVoice(agentId, await run);
  }

  return { catalog, read, assign };
}

const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => {
  const status = e instanceof HttpError ? e.statusCode : 502;
  return reply.code(status).send({ error: e instanceof Error ? e.message : String(e) });
};

export function registerAgentVoiceRoutes(app: FastifyInstance, voices = createAgentVoices(defaultVoiceDeps())) {
  app.get<{ Querystring: { force?: string } }>("/api/modules/hub/voices", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      return await voices.catalog(req.query.force === "1");
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { agentId: string } }>("/api/modules/hub/agents/:agentId/voice", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      return await voices.read(req.params.agentId);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put<{ Params: { agentId: string }; Body: { voice?: unknown } }>("/api/modules/hub/agents/:agentId/voice", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (!("voice" in body) || !(body.voice === null || (typeof body.voice === "string" && body.voice !== ""))) {
      return reply.code(400).send({ error: 'send {"voice": "<vox voice slug>"} to pin, or {"voice": null} to inherit the fleet default' });
    }
    try {
      const result = await voices.assign(req.params.agentId, body.voice);
      return result.ok ? result : reply.code(409).send(result);
    } catch (e) {
      return fail(reply, e);
    }
  });
}

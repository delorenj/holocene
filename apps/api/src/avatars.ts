import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { load } from "js-yaml";

const execFileAsync = promisify(execFile);

// One avatar per agent, set anywhere, shown everywhere.
//
// Holocene owns the canonical copy (HOLOCENE_AVATAR_DIR: index.json + files/<agent>.<hash>.jpg). Every surface reads
// it: the hub canvas, the Settings page, and the Agent Pad (services/pad-roster copies the files it serves). Each
// connected gateway is a two-way mirror of it, last writer wins:
//
//   - set in Holocene (PUT)             -> stored, then pushed to the agent's gateways (Telegram setMyProfilePhoto)
//   - changed on the gateway             -> the sync pass sees a new photo id and pulls it in
//   - no avatar yet                      -> the sync pass pulls whatever the gateway has
//
// Telegram is the only gateway today. The bot token is the profile's own op:// reference (config.yaml
// secrets.onepassword.env.TELEGRAM_BOT_TOKEN), read per call and never logged or stored. A profile whose token
// cannot be read is never written to; its avatar can still be pulled read-only from the public t.me picture of the
// registry's bot username.

const REGISTRY_PATH = process.env.HERMES_REGISTRY_PATH ?? join(homedir(), ".hermes/agents-registry.yaml");
const PROFILES_DIR = process.env.HERMES_PROFILES_DIR ?? join(dirname(REGISTRY_PATH), "profiles");
const STORE_DIR = process.env.HOLOCENE_AVATAR_DIR ?? join(homedir(), ".local/share/holocene/avatars");
const OP_BIN = process.env.OP_BIN ?? "op";
const TG_API = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
const SYNC_EVERY_MS = Number(process.env.HOLOCENE_AVATAR_SYNC_MS ?? 10 * 60_000);
const MAX_BYTES = 5 * 1024 * 1024;
const PUSH_SETTLE_MS = Number(process.env.HOLOCENE_AVATAR_SETTLE_MS ?? 1500);
export const FILE_URL_PREFIX = "/api/modules/avatars/files/";

export type TelegramMirror = {
  botId?: number;
  username?: string;
  /** The photo id Telegram showed after our last pull or push: a different one means it changed over there. */
  fileUniqueId?: string | null;
  syncedAt?: string;
  direction?: "pull" | "push";
  /** Holocene's copy has not reached Telegram yet (push failed or token unreadable). */
  pendingPush?: boolean;
  /** The profile names a token that cannot be read: this bot is never written to, only read through t.me. */
  tokenUnreadable?: boolean;
  error?: string;
};

export type AvatarRecord = {
  file: string;
  hash: string;
  source: "holocene" | "telegram";
  updatedAt: string;
  telegram?: TelegramMirror;
};

type Index = { agents: Record<string, AvatarRecord | { telegram: TelegramMirror; file?: undefined }> };

export type GatewayStatus = {
  kind: "telegram";
  connected: boolean;
  bot?: string;
  state: "in_sync" | "pending" | "no_photo" | "read_only" | "error" | "not_configured";
  detail?: string;
  syncedAt?: string;
};

export type AvatarRow = {
  id: string;
  name: string;
  avatar: string | null;
  source: "holocene" | "telegram" | null;
  updatedAt?: string;
  gateways: GatewayStatus[];
};

// ---------------------------------------------------------------- store

let writeChain: Promise<unknown> = Promise.resolve();
/** Every read-modify-write of index.json goes through here, one at a time. */
function withIndex<T>(fn: (idx: Index) => Promise<T> | T): Promise<T> {
  const run = writeChain.then(async () => {
    const idx = await readIndex();
    const out = await fn(idx);
    await mkdir(STORE_DIR, { recursive: true });
    const tmp = join(STORE_DIR, ".index.json.tmp");
    await writeFile(tmp, JSON.stringify(idx, null, 1) + "\n");
    await rename(tmp, join(STORE_DIR, "index.json"));
    return out;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

async function readIndex(): Promise<Index> {
  try {
    const parsed = JSON.parse(await readFile(join(STORE_DIR, "index.json"), "utf8")) as Index;
    return parsed && typeof parsed.agents === "object" ? parsed : { agents: {} };
  } catch {
    return { agents: {} };
  }
}

/** Synchronous read for the hub payload: agent id -> avatar URL. */
export function avatarUrls(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const idx = JSON.parse(readFileSync(join(STORE_DIR, "index.json"), "utf8")) as Index;
    for (const [id, r] of Object.entries(idx.agents ?? {})) if (r.file) out.set(id, FILE_URL_PREFIX + r.file);
  } catch { /* no store yet */ }
  return out;
}

export function isJpeg(b: Buffer): boolean {
  return b.length > 64 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Store bytes as the agent's avatar file (content-addressed) and drop the agent's older files. */
async function storeFile(agentId: string, bytes: Buffer): Promise<{ file: string; hash: string }> {
  const hash = sha(bytes);
  const file = `${agentId}.${hash.slice(0, 16)}.jpg`;
  const dir = join(STORE_DIR, "files");
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, file))) {
    await writeFile(join(dir, `.${file}.tmp`), bytes);
    await rename(join(dir, `.${file}.tmp`), join(dir, file));
  }
  return { file, hash };
}

async function pruneFiles(agentId: string, keep: string) {
  const dir = join(STORE_DIR, "files");
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    // agent ids never contain a dot, so "<id>." can only be this agent's files
    if (f.startsWith(`${agentId}.`) && f !== keep) await unlink(join(dir, f)).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- registry + gateway

type AgentRow = { id: string; name: string; profile: string; botUsername?: string };

export function readAgents(): AgentRow[] {
  try {
    const parsed = load(readFileSync(REGISTRY_PATH, "utf8")) as { agents?: Record<string, Record<string, unknown>> } | null;
    return Object.entries(parsed?.agents ?? {}).map(([id, cfg]) => {
      const tg = (cfg.telegram ?? {}) as Record<string, unknown>;
      const bot = typeof tg.bot_username === "string" && tg.bot_username.trim() ? tg.bot_username.replace(/^@/, "") : undefined;
      return {
        id,
        name: typeof cfg.display_name === "string" ? cfg.display_name : id,
        profile: typeof cfg.profile_name === "string" && cfg.profile_name.trim() ? cfg.profile_name : id,
        botUsername: bot
      };
    });
  } catch {
    return [];
  }
}

export function telegramTokenRef(profile: string): string | undefined {
  try {
    const cfg = load(readFileSync(join(PROFILES_DIR, profile, "config.yaml"), "utf8")) as Record<string, any> | null;
    const ref = cfg?.secrets?.onepassword?.env?.TELEGRAM_BOT_TOKEN;
    return typeof ref === "string" && ref.startsWith("op://") ? ref : undefined;
  } catch {
    return undefined;
  }
}

export type Secrets = (ref: string) => Promise<string | undefined>;
export const opRead: Secrets = async (ref) => {
  try {
    const { stdout } = await execFileAsync(OP_BIN, ["read", "--no-newline", ref], { timeout: 30_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
};

/** The Bot API calls an avatar needs. Errors carry the method and Telegram's description, never the token. */
export class TelegramBot {
  constructor(private token: string, private http: typeof fetch = fetch) {}

  async call<T = any>(method: string, params?: Record<string, string | number>, body?: FormData): Promise<T> {
    const q = params ? "?" + new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString() : "";
    let res: Response;
    try {
      res = await this.http(`${TG_API}/bot${this.token}/${method}${q}`, { method: body ? "POST" : "GET", body, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new Error(`${method}: ${(e as Error).name}`);
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`${method}: ${String(json.description ?? `HTTP ${res.status}`).slice(0, 160)}`);
    return json.result as T;
  }

  async me() {
    return this.call<{ id: number; username: string }>("getMe");
  }

  async currentPhoto(botId: number) {
    const r = await this.call<{ photos: { file_id: string; file_unique_id: string; width: number }[][] }>("getUserProfilePhotos", { user_id: botId, limit: 1 });
    const sizes = r.photos?.[0];
    return sizes?.length ? sizes.reduce((a, b) => (b.width > a.width ? b : a)) : null;
  }

  async download(fileId: string): Promise<Buffer> {
    const { file_path } = await this.call<{ file_path: string }>("getFile", { file_id: fileId });
    const res = await this.http(`${TG_API}/file/bot${this.token}/${file_path}`, { signal: AbortSignal.timeout(30_000) }).catch((e) => {
      throw new Error(`download: ${(e as Error).name}`);
    });
    if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async setPhoto(jpeg: Buffer) {
    const form = new FormData();
    form.append("photo", JSON.stringify({ type: "static", photo: "attach://avatar" }));
    form.append("avatar", new Blob([jpeg], { type: "image/jpeg" }), "avatar.jpg");
    await this.call("setMyProfilePhoto", undefined, form);
  }
}

export type Deps = { secrets: Secrets; http: typeof fetch; now: () => Date; log?: FastifyBaseLogger };
const defaultDeps = (log?: FastifyBaseLogger): Deps => ({ secrets: opRead, http: fetch, now: () => new Date(), log });

async function botFor(agent: AgentRow, deps: Deps): Promise<{ bot?: TelegramBot; why?: string }> {
  const ref = telegramTokenRef(agent.profile);
  if (!ref) return { why: "no Telegram token in the profile" };
  const token = await deps.secrets(ref);
  if (!token) return { why: "the profile's Telegram token could not be read" };
  return { bot: new TelegramBot(token, deps.http) };
}

/** Public t.me picture of a bot (no token): the read-only fallback. */
async function publicPhoto(username: string, http: typeof fetch): Promise<Buffer | null> {
  const res = await http(`https://t.me/i/userpic/320/${encodeURIComponent(username)}.jpg`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const b = Buffer.from(await res.arrayBuffer());
  return isJpeg(b) ? b : null;
}

/** Write the hermes-project-avatar skill's receipt, so the skill and Holocene agree about what the bot wears. */
async function writeReceipt(agent: AgentRow, mirror: TelegramMirror, hash: string, now: Date) {
  const dir = join(PROFILES_DIR, agent.profile, "cache");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "avatar-telegram.json"), JSON.stringify({
    bot_id: mirror.botId, bot_username: mirror.username ? `@${mirror.username}` : undefined,
    source: "holocene settings (https://holocene.delo.sh/settings)", content_hash: `sha256:${hash}`,
    checked_at: now.toISOString(), photo_file_unique_id: mirror.fileUniqueId,
    verified_download: join(STORE_DIR, "files")
  }, null, 2) + "\n");
}

// ---------------------------------------------------------------- operations

/** Push Holocene's copy to the agent's Telegram bot and record what Telegram now shows. */
async function pushTelegram(agent: AgentRow, rec: AvatarRecord, deps: Deps): Promise<TelegramMirror> {
  const prev = rec.telegram ?? {};
  const { bot, why } = await botFor(agent, deps);
  if (!bot) {
    // No token at all: nothing to push to. A token that cannot be read: keep the push pending for when it can.
    const ref = Boolean(telegramTokenRef(agent.profile));
    return { ...prev, pendingPush: ref, error: why, tokenUnreadable: ref || undefined };
  }
  try {
    const me = await bot.me();
    const before = (await bot.currentPhoto(me.id))?.file_unique_id;
    await bot.setPhoto(await readFile(join(STORE_DIR, "files", rec.file)));
    // Telegram can take a moment to list the new photo; recording the old id would make the next pass pull our own
    // upload back as if it had been changed over there.
    let photo = await bot.currentPhoto(me.id);
    for (let i = 0; i < 4 && photo?.file_unique_id === before; i++) {
      await new Promise((r) => setTimeout(r, PUSH_SETTLE_MS));
      photo = await bot.currentPhoto(me.id);
    }
    if (photo?.file_unique_id === before) throw new Error("setMyProfilePhoto: the new photo never appeared");
    const mirror: TelegramMirror = { botId: me.id, username: me.username, fileUniqueId: photo?.file_unique_id ?? null, syncedAt: deps.now().toISOString(), direction: "push" };
    await writeReceipt(agent, mirror, rec.hash, deps.now()).catch(() => undefined);
    deps.log?.info({ agent: agent.id, bot: me.username }, "avatar pushed to telegram");
    return mirror;
  } catch (e) {
    return { ...prev, pendingPush: true, error: (e as Error).message };
  }
}

/** Set an avatar from Holocene: store it, then mirror it to every connected gateway. */
export async function setAvatar(agentId: string, jpeg: Buffer, deps: Deps = defaultDeps()): Promise<AvatarRow> {
  const agent = readAgents().find((a) => a.id === agentId);
  if (!agent) throw Object.assign(new Error(`unknown agent ${agentId}`), { statusCode: 404 });
  if (!isJpeg(jpeg)) throw Object.assign(new Error("avatar must be a JPEG"), { statusCode: 415 });
  if (jpeg.length > MAX_BYTES) throw Object.assign(new Error("avatar is larger than 5 MB"), { statusCode: 413 });
  const { file, hash } = await storeFile(agentId, jpeg);
  const rec: AvatarRecord = await withIndex((idx) => {
    const prev = idx.agents[agentId];
    const next: AvatarRecord = { file, hash, source: "holocene", updatedAt: deps.now().toISOString(), telegram: { ...(prev?.telegram ?? {}), pendingPush: true } };
    idx.agents[agentId] = next;
    return next;
  });
  await pruneFiles(agentId, file);
  const mirror = await pushTelegram(agent, rec, deps);
  await withIndex((idx) => {
    const cur = idx.agents[agentId];
    if (cur?.file === file) cur.telegram = mirror; // a newer upload in between keeps its own state
  });
  return (await listAvatars()).find((r) => r.id === agentId)!;
}

/** Take the gateway's current avatar into Holocene (the sync pass, or "Pull from Telegram"). */
export async function pullAvatar(agentId: string, deps: Deps = defaultDeps()): Promise<AvatarRow | undefined> {
  const agent = readAgents().find((a) => a.id === agentId);
  if (!agent) throw Object.assign(new Error(`unknown agent ${agentId}`), { statusCode: 404 });
  await syncOne(agent, deps, true);
  return (await listAvatars()).find((r) => r.id === agentId);
}

/**
 * One agent, one pass. With a usable token: pull when Telegram's photo changed since we last looked (or Holocene has
 * none), push when Holocene's copy has not reached Telegram. Without one: read-only pull of the public picture, and
 * only when Holocene has nothing (a public picture carries no id to tell a change from an old copy).
 */
async function syncOne(agent: AgentRow, deps: Deps, forcePull = false): Promise<void> {
  const idx = await readIndex();
  const cur = idx.agents[agent.id];
  const mirror: TelegramMirror = cur?.telegram ?? {};
  const now = deps.now().toISOString();
  const { bot, why } = await botFor(agent, deps);

  if (!bot) {
    const unreadable = Boolean(telegramTokenRef(agent.profile));
    if (cur?.file && !forcePull) {
      if (why !== mirror.error || unreadable !== Boolean(mirror.tokenUnreadable)) await noteError(agent.id, why, unreadable);
      return;
    }
    const bytes = agent.botUsername ? await publicPhoto(agent.botUsername, deps.http).catch(() => null) : null;
    if (!bytes) {
      await noteError(agent.id, why, unreadable);
      return;
    }
    const { file, hash } = await storeFile(agent.id, bytes);
    await withIndex((i) => {
      i.agents[agent.id] = { file, hash, source: "telegram", updatedAt: now,
        telegram: { ...(cur?.telegram ?? {}), username: agent.botUsername, syncedAt: now, direction: "pull", error: why, tokenUnreadable: unreadable || undefined } };
    });
    await pruneFiles(agent.id, file);
    return;
  }

  try {
    const me = await bot.me();
    const photo = await bot.currentPhoto(me.id);
    const sameBot = mirror.botId === undefined || mirror.botId === me.id;
    const changedThere = photo && (forcePull || !sameBot || photo.file_unique_id !== mirror.fileUniqueId);
    if (cur?.file && !forcePull && (mirror.pendingPush || (!photo && cur.source === "holocene"))) {
      // Holocene's copy is the newer one (or Telegram has none): send it.
      const pushed = await pushTelegram(agent, cur as AvatarRecord, deps);
      await withIndex((i) => { const r = i.agents[agent.id]; if (r?.file === cur.file) r.telegram = pushed; });
      return;
    }
    if (photo && (changedThere || !cur?.file)) {
      const bytes = await bot.download(photo.file_id);
      if (!isJpeg(bytes)) throw new Error("download: not a JPEG");
      const { file, hash } = await storeFile(agent.id, bytes);
      await withIndex((i) => {
        i.agents[agent.id] = { file, hash, source: "telegram", updatedAt: now,
          telegram: { botId: me.id, username: me.username, fileUniqueId: photo.file_unique_id, syncedAt: now, direction: "pull" } };
      });
      await pruneFiles(agent.id, file);
      deps.log?.info({ agent: agent.id, bot: me.username }, "avatar pulled from telegram");
      return;
    }
    await withIndex((i) => {
      const r = i.agents[agent.id];
      const t: TelegramMirror = { ...(r?.telegram ?? {}), botId: me.id, username: me.username, fileUniqueId: photo?.file_unique_id ?? null, syncedAt: now };
      delete t.error;
      delete t.tokenUnreadable;
      if (r) r.telegram = t;
      else i.agents[agent.id] = { telegram: t };
    });
  } catch (e) {
    await noteError(agent.id, (e as Error).message);
  }
}

/** Record a gateway problem for an agent, whether or not it has an avatar yet. */
function noteError(agentId: string, error: string | undefined, tokenUnreadable = false) {
  return withIndex((i) => {
    const r = i.agents[agentId];
    const t: TelegramMirror = { ...(r?.telegram ?? {}), error, tokenUnreadable: tokenUnreadable || undefined };
    if (r) r.telegram = t;
    else i.agents[agentId] = { telegram: t };
  });
}

export async function syncAll(deps: Deps = defaultDeps()): Promise<void> {
  for (const agent of readAgents()) {
    try {
      await syncOne(agent, deps);
    } catch (e) {
      deps.log?.warn({ agent: agent.id, err: (e as Error).message }, "avatar sync failed");
    }
  }
}

export async function listAvatars(): Promise<AvatarRow[]> {
  const idx = await readIndex();
  return readAgents().map((a) => {
    const r = idx.agents[a.id];
    const t = r?.telegram;
    const ref = telegramTokenRef(a.profile);
    let gw: GatewayStatus;
    if (!ref && !a.botUsername) gw = { kind: "telegram", connected: false, state: "not_configured", detail: "no Telegram bot" };
    else if (!ref) gw = { kind: "telegram", connected: false, bot: a.botUsername, state: "read_only", detail: "no token in the profile: pulled read-only from the public picture, never written" };
    else if (t?.tokenUnreadable) gw = { kind: "telegram", connected: false, bot: t.username ?? a.botUsername, state: "read_only", detail: "the profile's token cannot be read: pulled read-only from the public picture, never written" };
    else if (!t?.syncedAt && !t?.error) gw = { kind: "telegram", connected: true, bot: a.botUsername, state: "pending", detail: "not checked yet" };
    else if (t?.pendingPush) gw = { kind: "telegram", connected: true, bot: t.username ?? a.botUsername, state: t.error ? "error" : "pending", detail: t.error ?? "waiting to reach Telegram" };
    else if (t?.error) gw = { kind: "telegram", connected: true, bot: t.username ?? a.botUsername, state: "error", detail: t.error };
    else if (t?.fileUniqueId === null) gw = { kind: "telegram", connected: true, bot: t.username ?? a.botUsername, state: "no_photo", detail: "the bot has no photo" };
    else gw = { kind: "telegram", connected: true, bot: t?.username ?? a.botUsername, state: "in_sync" };
    gw.syncedAt = t?.syncedAt;
    return {
      id: a.id,
      name: a.name,
      avatar: r?.file ? FILE_URL_PREFIX + r.file : null,
      source: r?.file ? (r as AvatarRecord).source : null,
      updatedAt: r?.file ? (r as AvatarRecord).updatedAt : undefined,
      gateways: [gw]
    };
  });
}

// ---------------------------------------------------------------- routes

export function registerAvatarRoutes(app: FastifyInstance) {
  const deps = defaultDeps(app.log);
  app.addContentTypeParser(["image/jpeg"], { parseAs: "buffer", bodyLimit: MAX_BYTES + 1024 }, (_req, body, done) => done(null, body));

  app.get("/api/modules/avatars", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { agents: await listAvatars() };
  });

  app.get<{ Params: { name: string } }>("/api/modules/avatars/files/:name", async (req, reply) => {
    const name = req.params.name;
    if (!/^[a-z0-9][a-z0-9-]*\.[0-9a-f]{16}\.jpg$/.test(name)) return reply.code(404).send();
    const bytes = await readFile(join(STORE_DIR, "files", name)).catch(() => null);
    if (!bytes) return reply.code(404).send();
    reply.header("Cache-Control", "public, max-age=31536000, immutable").type("image/jpeg");
    return bytes;
  });

  app.put<{ Params: { agentId: string }; Body: Buffer }>("/api/modules/avatars/:agentId", async (req, reply) => {
    const body = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: "send the avatar as Content-Type: image/jpeg" });
    try {
      return await setAvatar(req.params.agentId, body, deps);
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.post<{ Params: { agentId: string } }>("/api/modules/avatars/:agentId/pull", async (req, reply) => {
    try {
      return (await pullAvatar(req.params.agentId, deps)) ?? reply.code(404).send({ error: "unknown agent" });
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  if (SYNC_EVERY_MS > 0) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try { await syncAll(deps); } finally { running = false; }
    };
    const first = setTimeout(() => void tick(), 15_000);
    const timer = setInterval(() => void tick(), SYNC_EVERY_MS);
    app.addHook("onClose", async () => { clearTimeout(first); clearInterval(timer); });
  }
}

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// One avatar, every surface: Holocene's copy and each Telegram bot mirror each other, last writer wins.
// A fake Bot API stands in for Telegram; the store, registry and profiles are temp dirs.

const ROOT = await mkdtemp(join(tmpdir(), "holocene-avatars-"));
process.env.HERMES_REGISTRY_PATH = join(ROOT, "agents-registry.yaml");
process.env.HERMES_PROFILES_DIR = join(ROOT, "profiles");
process.env.HOLOCENE_AVATAR_DIR = join(ROOT, "store");
process.env.HOLOCENE_AVATAR_SETTLE_MS = "1";
const av = await import("./avatars.js");

const jpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag.padEnd(120, "."))]);
const TOKEN = "111:SECRET-holocene";

await writeFile(process.env.HERMES_REGISTRY_PATH, `agents:
  holocene-pm: {display_name: Holocene PM, profile_name: holocene-pm, telegram: {bot_username: holocene_pm_bot}}
  grolf-pm: {display_name: Grolf, profile_name: grolf-pm, telegram: {bot_username: Gr0lfBot}}
  quiet-pm: {display_name: Quiet PM, profile_name: quiet-pm}
`);
for (const p of ["holocene-pm", "grolf-pm", "quiet-pm"]) await mkdir(join(ROOT, "profiles", p), { recursive: true });
await writeFile(join(ROOT, "profiles/holocene-pm/config.yaml"), "secrets:\n  onepassword:\n    env:\n      TELEGRAM_BOT_TOKEN: op://V/holocene/token\n");
await writeFile(join(ROOT, "profiles/grolf-pm/config.yaml"), "secrets:\n  onepassword:\n    env:\n      TELEGRAM_BOT_TOKEN: op://V/missing/token\n");

/** A Telegram with one bot. `photos[0]` is the current profile photo. */
class FakeTelegram {
  photos: { id: string; bytes: Buffer }[] = [];
  sets = 0;
  failSet = false;
  publicPics: Record<string, Buffer> = {};
  seq = 0;
  botId = 42;
  /** Holds the next download until released: a sync pass caught mid-flight. */
  gate?: Promise<void>;
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "t.me") {
      const name = decodeURIComponent(url.pathname.split("/").pop()!.replace(/\.jpg$/, ""));
      const pic = this.publicPics[name];
      return pic ? new Response(pic) : new Response("gif", { status: 404 });
    }
    const [, kind, botPart, ...rest] = url.pathname.split("/");
    const token = (kind === "file" ? botPart : kind).replace(/^bot/, "");
    if (token !== TOKEN) return Response.json({ ok: false, description: "Unauthorized" }, { status: 401 });
    if (kind === "file") {
      const bytes = this.photos.find((p) => p.id === rest.join("/"))!.bytes;
      if (this.gate) await this.gate;
      return new Response(bytes);
    }
    const method = botPart;
    const ok = (result: unknown) => Response.json({ ok: true, result });
    if (method === "getMe") return ok({ id: this.botId, username: "HolocenePMBot" });
    if (method === "getUserProfilePhotos") {
      return ok({ photos: this.photos.slice(0, 1).map((p) => [{ file_id: `s${p.id}`, file_unique_id: `${p.id}s`, width: 160 }, { file_id: p.id, file_unique_id: p.id, width: 640 }]) });
    }
    if (method === "getFile") return ok({ file_path: url.searchParams.get("file_id") });
    if (method === "setMyProfilePhoto") {
      if (this.failSet) return Response.json({ ok: false, description: "Bad Request: PHOTO_INVALID" }, { status: 400 });
      const form = init!.body as FormData;
      assert.equal(JSON.parse(String(form.get("photo"))).photo, "attach://avatar");
      const file = form.get("avatar") as Blob;
      this.sets++;
      this.photos.unshift({ id: `P${++this.seq}`, bytes: Buffer.from(await file.arrayBuffer()) });
      return ok(true);
    }
    throw new Error(`unexpected ${method}`);
  };
}

const tg = new FakeTelegram();
const deps = { secrets: async (ref: string) => (ref === "op://V/holocene/token" ? TOKEN : undefined), http: tg.fetch, now: () => new Date("2026-10-18T12:00:00Z") };
const row = async (id: string) => (await av.listAvatars()).find((r) => r.id === id)!;
const index = () => JSON.parse(readFileSync(join(ROOT, "store/index.json"), "utf8"));

test("an agent with no avatar takes its Telegram photo", async () => {
  tg.photos = [{ id: "T1", bytes: jpeg("telegram-1") }];
  await av.syncAll(deps);
  const r = await row("holocene-pm");
  assert.equal(r.source, "telegram");
  assert.match(r.avatar!, /^\/api\/modules\/avatars\/files\/holocene-pm\.[0-9a-f]{16}\.jpg$/);
  assert.equal(r.gateways[0].state, "in_sync");
  assert.equal((await row("quiet-pm")).gateways[0].state, "not_configured");
});

test("setting it in Holocene pushes it to the bot, and the next pass leaves it alone", async () => {
  const mine = jpeg("from-holocene");
  const r = await av.setAvatar("holocene-pm", mine, deps);
  assert.equal(r.source, "holocene");
  assert.equal(r.gateways[0].state, "in_sync");
  assert.equal(tg.sets, 1);
  assert.deepEqual(tg.photos[0].bytes, mine, "the bot now wears exactly what was uploaded");
  const receipt = JSON.parse(readFileSync(join(ROOT, "profiles/holocene-pm/cache/avatar-telegram.json"), "utf8"));
  assert.equal(receipt.photo_file_unique_id, tg.photos[0].id);
  await av.syncAll(deps);
  assert.equal((await row("holocene-pm")).source, "holocene", "our own upload is not pulled back as a Telegram change");
  assert.equal(tg.sets, 1, "and not pushed twice");
});

test("a change made on Telegram afterwards wins (last writer)", async () => {
  tg.photos.unshift({ id: "T2", bytes: jpeg("set-by-the-skill") });
  await av.syncAll(deps);
  const r = await row("holocene-pm");
  assert.equal(r.source, "telegram");
  const file = r.avatar!.split("/").pop()!;
  assert.deepEqual(readFileSync(join(ROOT, "store/files", file)), tg.photos[0].bytes);
});

test("a failed push is kept pending and retried by the next pass", async () => {
  tg.failSet = true;
  const r = await av.setAvatar("holocene-pm", jpeg("retry-me"), deps);
  assert.equal(r.source, "holocene");
  assert.equal(r.gateways[0].state, "error");
  assert.match(r.gateways[0].detail!, /PHOTO_INVALID/);
  tg.failSet = false;
  await av.syncAll(deps);
  const after = await row("holocene-pm");
  assert.equal(after.gateways[0].state, "in_sync");
  assert.equal(after.source, "holocene");
  assert.deepEqual(tg.photos[0].bytes, jpeg("retry-me"));
});

test("an unreadable token is never written to: read-only public picture, Holocene-only uploads", async () => {
  tg.publicPics.Gr0lfBot = jpeg("grolf-public");
  const setsBefore = tg.sets;
  await av.syncAll(deps);
  let g = await row("grolf-pm");
  assert.equal(g.source, "telegram");
  assert.equal(g.gateways[0].state, "read_only");
  const r = await av.setAvatar("grolf-pm", jpeg("grolf-local"), deps);
  assert.equal(r.source, "holocene");
  assert.equal(tg.sets, setsBefore, "nothing was sent to any bot");
  await av.syncAll(deps);
  g = await row("grolf-pm");
  assert.equal(g.source, "holocene", "the public picture never overwrites a Holocene upload");
  assert.equal(g.gateways[0].state, "read_only");
});

test("a bot Telegram refuses shows as an error even with no avatar", async () => {
  await writeFile(process.env.HERMES_REGISTRY_PATH!, readFileSync(process.env.HERMES_REGISTRY_PATH!, "utf8") + "  dead-pm: {display_name: Dead PM, profile_name: dead-pm}\n");
  await mkdir(join(ROOT, "profiles/dead-pm"), { recursive: true });
  await writeFile(join(ROOT, "profiles/dead-pm/config.yaml"), "secrets:\n  onepassword:\n    env:\n      TELEGRAM_BOT_TOKEN: op://V/dead/token\n");
  const d2 = { ...deps, secrets: async (ref: string) => (ref === "op://V/dead/token" ? "999:REVOKED" : deps.secrets(ref)) };
  await av.syncAll(d2);
  const r = await row("dead-pm");
  assert.equal(r.avatar, null);
  assert.equal(r.gateways[0].state, "error");
  assert.match(r.gateways[0].detail!, /Unauthorized/);
});

test("bad uploads are refused", async () => {
  await assert.rejects(av.setAvatar("holocene-pm", Buffer.from("not an image at all, just text padding padding padding padding padding"), deps), /JPEG/);
  await assert.rejects(av.setAvatar("nobody-pm", jpeg("x"), deps), /unknown agent/);
});

test("pull takes the bot's current photo on demand", async () => {
  await av.setAvatar("holocene-pm", jpeg("mine-again"), deps);
  tg.photos.unshift({ id: "T3", bytes: jpeg("telegram-3") });
  const r = await av.pullAvatar("holocene-pm", deps);
  assert.equal(r!.source, "telegram");
});

test("old files go, and the token never lands on disk", async () => {
  const files = readFileSync(join(ROOT, "store/index.json"), "utf8");
  assert.ok(!files.includes("SECRET"));
  const kept = Object.values(index().agents).map((r: any) => r.file).filter(Boolean);
  for (const f of kept) assert.ok(existsSync(join(ROOT, "store/files", f)));
  assert.equal(av.avatarUrls().get("holocene-pm"), av.FILE_URL_PREFIX + index().agents["holocene-pm"].file);
});

test("two overlapping uploads leave a record whose file exists", async () => {
  await Promise.all([av.setAvatar("holocene-pm", jpeg("double-1"), deps), av.setAvatar("holocene-pm", jpeg("double-2"), deps)]);
  const rec = index().agents["holocene-pm"];
  assert.ok(existsSync(join(ROOT, "store/files", rec.file)), "the surviving record points at a real file");
  assert.equal((await row("holocene-pm")).gateways[0].state, "in_sync");
  assert.deepEqual(tg.photos[0].bytes, readFileSync(join(ROOT, "store/files", rec.file)), "Telegram wears what Holocene records");
});

test("an upload during a sync pass is not undone by that pass", async () => {
  tg.photos.unshift({ id: "T4", bytes: jpeg("changed-on-telegram") });
  let release!: () => void;
  tg.gate = new Promise((r) => (release = r));
  const pass = av.syncAll(deps);
  await new Promise((r) => setTimeout(r, 20));
  const upload = av.setAvatar("holocene-pm", jpeg("operator-upload"), deps);
  await new Promise((r) => setTimeout(r, 30)); // without a per-agent lock the upload finishes in here, mid-pass
  release();
  tg.gate = undefined;
  await pass;
  await upload;
  const r = await row("holocene-pm");
  assert.equal(r.source, "holocene");
  assert.deepEqual(readFileSync(join(ROOT, "store/files", r.avatar!.split("/").pop()!)), jpeg("operator-upload"));
  assert.deepEqual(tg.photos[0].bytes, jpeg("operator-upload"));
});

test("a pending push does not overwrite a later change on Telegram", async () => {
  tg.failSet = true;
  await av.setAvatar("holocene-pm", jpeg("stale-upload"), deps);
  tg.failSet = false;
  tg.photos.unshift({ id: "T5", bytes: jpeg("newer-on-telegram") });
  await av.syncAll(deps);
  const r = await row("holocene-pm");
  assert.equal(r.source, "telegram");
  assert.deepEqual(tg.photos[0].bytes, jpeg("newer-on-telegram"), "Telegram keeps the later write");
  assert.equal(r.gateways[0].state, "in_sync");
});

test("a profile pointed at a new bot gets the Holocene avatar pushed, not replaced", async () => {
  await av.setAvatar("holocene-pm", jpeg("canonical"), deps);
  tg.botId = 77;
  tg.photos.unshift({ id: "T6", bytes: jpeg("new-bots-old-photo") });
  await av.syncAll(deps);
  const r = await row("holocene-pm");
  assert.equal(r.source, "holocene");
  assert.deepEqual(tg.photos[0].bytes, jpeg("canonical"));
  tg.botId = 42;
});

test("pulling the public picture clears a pending push", async () => {
  await av.setAvatar("grolf-pm", jpeg("grolf-upload-again"), deps);
  await av.pullAvatar("grolf-pm", deps);
  assert.notEqual(index().agents["grolf-pm"].telegram.pendingPush, true);
});

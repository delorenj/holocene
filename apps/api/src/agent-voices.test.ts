import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { createAgentVoices, parseCatalog, parseFlumeVoice, registerAgentVoiceRoutes, type FlumeRun, type VoiceDeps } from "./agent-voices.js";

// The Agents page voice picker is a bridge to `flume identity voice`, never a second writer.
// A fake flume and a fake Vox catalog stand in for the real ones.

const report = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    apply: false,
    employee: "holocene-pm",
    profile: "holocene-pm",
    action: "show",
    speaks: { voice: "kurzgesagt", provider: "vox", source: "fleet default" },
    fleet_default: "kurzgesagt",
    changed: false,
    writes: [],
    blockers: [],
    detail: "holocene-pm speaks kurzgesagt (fleet default)",
    ...over
  });

function fakeDeps(script: (args: string[]) => FlumeRun | Promise<FlumeRun>, catalog: () => Promise<unknown[]> = async () => []) {
  const calls: string[][] = [];
  let t = 1_000_000;
  const deps: VoiceDeps = {
    async runFlume(args) {
      calls.push(args);
      return script(args);
    },
    async fetchCatalog() {
      return parseCatalog(await catalog());
    },
    now: () => t
  };
  return { deps, calls, tick: (ms: number) => (t += ms) };
}

test("parseCatalog keeps valid slugs, dedupes and sorts by display name", () => {
  const voices = parseCatalog([
    { name: "rick", display_name: "Rick Sanchez", tags: ["cartoon"], persona: "rick-sanchez" },
    { name: "carlin", display_name: "George Carlin", tags: ["pm", 3] },
    { name: "carlin", display_name: "dup" },
    { name: "bad slug!", display_name: "Nope" },
    { name: "brule" },
    null
  ]);
  assert.deepEqual(voices.map((v) => v.name), ["brule", "carlin", "rick"]);
  assert.deepEqual(voices[1], { name: "carlin", displayName: "George Carlin", tags: ["pm"] });
  assert.equal(voices[2].persona, "rick-sanchez");
});

test("parseFlumeVoice maps a show report and refuses to guess on garbage", () => {
  const ok = parseFlumeVoice("holocene-pm", { code: 0, stdout: report(), stderr: "" });
  assert.equal(ok.ok, true);
  assert.equal(ok.voice, "kurzgesagt");
  assert.equal(ok.source, "fleet default");
  assert.equal(ok.fleetDefault, "kurzgesagt");

  const bad = parseFlumeVoice("holocene-pm", { code: 1, stdout: "boom", stderr: "Error: nope" });
  assert.equal(bad.ok, false);
  assert.equal(bad.voice, null);
  assert.equal(bad.blockers[0].code, "flume-output");

  const refused = parseFlumeVoice("dumply", { code: 1, stdout: report({ ok: false, speaks: { voice: null, source: "none" }, blockers: [{ code: "unknown-employee", detail: "no definition" }], detail: "refused" }), stderr: "" });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.blockers, [{ code: "unknown-employee", detail: "no definition" }]);
});

test("assign pins through flume --assign --apply, clear through --clear --apply", async () => {
  const { deps, calls } = fakeDeps((args) => ({
    code: 0,
    stdout: report({ action: args.includes("--clear") ? "clear" : "assign", apply: true, changed: true, speaks: { voice: args.includes("--clear") ? "kurzgesagt" : args[args.indexOf("--assign") + 1], source: args.includes("--clear") ? "fleet default" : "pinned" }, gateway: { action: "profile-cycle", confirmed: true, detail: "cycled" } }),
    stderr: ""
  }));
  const v = createAgentVoices(deps);
  const pinned = await v.assign("holocene-pm", "carlin");
  assert.deepEqual(calls[0], ["identity", "voice", "holocene-pm", "--assign", "carlin", "--apply", "--json"]);
  assert.equal(pinned.voice, "carlin");
  assert.equal(pinned.source, "pinned");
  assert.equal(pinned.gateway?.confirmed, true);

  const cleared = await v.assign("holocene-pm", null);
  assert.deepEqual(calls[1], ["identity", "voice", "holocene-pm", "--clear", "--apply", "--json"]);
  assert.equal(cleared.source, "fleet default");
});

test("assign rejects shell-shaped ids and voices before flume runs", async () => {
  const { deps, calls } = fakeDeps(() => ({ code: 0, stdout: report(), stderr: "" }));
  const v = createAgentVoices(deps);
  await assert.rejects(v.assign("../etc", "carlin"), /not a desk id/);
  await assert.rejects(v.assign("holocene-pm", "--clear"), /not a Vox voice slug/);
  await assert.rejects(v.read("a b"), /not a desk id/);
  assert.equal(calls.length, 0);
});

test("writes are serialized: the second assign waits for the first", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { deps } = fakeDeps(async (args) => {
    const who = args[2];
    order.push(`start:${who}`);
    if (who === "a-pm") await gate;
    order.push(`end:${who}`);
    return { code: 0, stdout: report({ employee: who }), stderr: "" };
  });
  const v = createAgentVoices(deps);
  const first = v.assign("a-pm", "rick");
  const second = v.assign("b-pm", "brule");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["start:a-pm"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["start:a-pm", "end:a-pm", "start:b-pm", "end:b-pm"]);
});

test("a failed write does not wedge the queue", async () => {
  let n = 0;
  const { deps } = fakeDeps(async () => {
    if (n++ === 0) throw new Error("could not run flume");
    return { code: 0, stdout: report(), stderr: "" };
  });
  const v = createAgentVoices(deps);
  await assert.rejects(v.assign("a-pm", "rick"), /could not run flume/);
  assert.equal((await v.assign("a-pm", "rick")).ok, true);
});

test("catalog caches for a minute and serves the last good list when Vox blips", async () => {
  let fetches = 0;
  let down = false;
  const { deps, tick } = fakeDeps(
    () => ({ code: 0, stdout: report(), stderr: "" }),
    async () => {
      fetches++;
      if (down) throw new Error("Vox unreachable");
      return [{ name: "rick", display_name: "Rick" }];
    }
  );
  const v = createAgentVoices(deps);
  assert.equal((await v.catalog()).voices.length, 1);
  await v.catalog();
  assert.equal(fetches, 1);
  tick(61_000);
  down = true;
  assert.equal((await v.catalog()).voices[0].name, "rick");
  assert.equal(fetches, 2);
});

test("routes: GET voice, PUT pin, 409 on a flume refusal, 400 on a bad body", async () => {
  const { deps } = fakeDeps((args) => {
    if (args[2] === "dumply") return { code: 1, stdout: report({ ok: false, blockers: [{ code: "unknown-employee", detail: "no definition" }], detail: "refused" }), stderr: "" };
    if (args.includes("--assign")) return { code: 0, stdout: report({ apply: true, changed: true, speaks: { voice: "rick", source: "pinned" } }), stderr: "" };
    return { code: 0, stdout: report(), stderr: "" };
  }, async () => [{ name: "rick", display_name: "Rick Sanchez" }]);
  const app = Fastify();
  registerAgentVoiceRoutes(app, createAgentVoices(deps));

  const cat = await app.inject({ method: "GET", url: "/api/modules/hub/voices" });
  assert.equal(cat.statusCode, 200);
  assert.equal(cat.json().voices[0].displayName, "Rick Sanchez");

  const got = await app.inject({ method: "GET", url: "/api/modules/hub/agents/holocene-pm/voice" });
  assert.equal(got.statusCode, 200);
  assert.equal(got.json().voice, "kurzgesagt");

  const put = await app.inject({ method: "PUT", url: "/api/modules/hub/agents/holocene-pm/voice", payload: { voice: "rick" } });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().source, "pinned");

  const refused = await app.inject({ method: "PUT", url: "/api/modules/hub/agents/dumply/voice", payload: { voice: "rick" } });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().blockers[0].code, "unknown-employee");

  const bad = await app.inject({ method: "PUT", url: "/api/modules/hub/agents/holocene-pm/voice", payload: { nope: 1 } });
  assert.equal(bad.statusCode, 400);

  const badId = await app.inject({ method: "GET", url: "/api/modules/hub/agents/a%20b/voice" });
  assert.equal(badId.statusCode, 400);
  await app.close();
});

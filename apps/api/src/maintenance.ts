/**
 * Event-store maintenance CLI (the API also prunes in-process every hour; see event-retention.ts).
 *
 *   node dist/maintenance.js prune [--dry-run]   delete expired rows now, in batches (safe while the API runs)
 *   node dist/maintenance.js vacuum-into <dest>  write a compacted copy (auto_vacuum=INCREMENTAL) for an atomic swap
 *   node dist/maintenance.js compact             return free pages to the OS (needs auto_vacuum=INCREMENTAL) + truncate the WAL
 *   node dist/maintenance.js stats               size, free pages, auto_vacuum mode, oldest event
 *
 * Reclaiming a large backlog once (the file never shrinks by itself on auto_vacuum=NONE):
 *   prune → vacuum-into <db>.compact (API keeps running; the copy is a consistent snapshot)
 *   → stop holocene-api → mv <db>.compact <db>, rm <db>-wal <db>-shm → start holocene-api.
 * The checkpoint table travels inside the snapshot, so the collector replays anything that
 * arrived after the copy from Bloodbank; event_id is unique, so replay is idempotent.
 *
 * Uses HOLOCENE_EVENT_DB / XDG_STATE_HOME exactly like the API.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventStore } from "./event-store.js";
import { pruneEvents, retentionFromEnv } from "./event-retention.js";

const path = process.env.HOLOCENE_EVENT_DB ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "holocene/events.sqlite3");
const [command, ...args] = process.argv.slice(2);
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

function stats(store: EventStore) {
  const pragma = (name: string) => Number(Object.values(store.db.prepare(`PRAGMA ${name}`).get()!)[0]);
  const pageSize = pragma("page_size");
  return {
    path, file: gib(statSync(path).size), pages: pragma("page_count"), free_pages: pragma("freelist_count"),
    free: gib(pragma("freelist_count") * pageSize), auto_vacuum: ["none", "full", "incremental"][pragma("auto_vacuum")],
    events: store.count, oldest_event_at: store.db.prepare("SELECT collected_at FROM events ORDER BY cursor LIMIT 1").get()?.collected_at ?? null,
  };
}

async function main() {
  if (!command || !["prune", "vacuum-into", "compact", "stats"].includes(command)) {
    console.error("usage: maintenance.js prune [--dry-run] | vacuum-into <dest> | compact | stats");
    process.exit(2);
  }
  if (!existsSync(path)) throw new Error(`no event store at ${path}`);
  const store = new EventStore(path);
  try {
    if (command === "stats") { console.log(JSON.stringify(stats(store), null, 2)); return; }
    if (command === "prune") {
      const policy = retentionFromEnv();
      if (!policy) { console.log("retention disabled (HOLOCENE_RETENTION=off)"); return; }
      const result = await pruneEvents(store, policy, { dryRun: args.includes("--dry-run") });
      console.log(JSON.stringify({ dry_run: args.includes("--dry-run"), ...result, ...stats(store) }, null, 2));
      return;
    }
    if (command === "vacuum-into") {
      const dest = args[0];
      if (!dest) throw new Error("vacuum-into needs a destination path");
      if (existsSync(dest)) throw new Error(`${dest} already exists`);
      // Applied by the VACUUM that follows; lets `compact` shrink the file in place from now on.
      store.db.exec("PRAGMA auto_vacuum=INCREMENTAL");
      store.db.prepare("VACUUM INTO ?").run(dest);
      console.log(JSON.stringify({ source: gib(statSync(path).size), dest, dest_size: gib(statSync(dest).size) }));
      return;
    }
    // compact
    const before = statSync(path).size;
    const mode = Number(Object.values(store.db.prepare("PRAGMA auto_vacuum").get()!)[0]);
    if (mode === 2) store.db.exec("PRAGMA incremental_vacuum");
    else console.error("auto_vacuum is not INCREMENTAL; free pages stay in the file (they are reused). Use vacuum-into + swap to shrink it.");
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    console.log(JSON.stringify({ before: gib(before), after: gib(statSync(path).size), ...stats(store) }, null, 2));
  } finally { store.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });

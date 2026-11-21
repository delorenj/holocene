import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import type { ProjectRecord } from "./hub-model.js";
import { safeRelPath } from "./live-model.js";
import { classifyProduct, publication, type Product, type ProductIssue } from "./products-model.js";

const exec = promisify(execFile);
const MAX_BYTES = 128 * 1024;
export type ProductsPayload = {
  generatedAt: string;
  registry: { state: "ok" | "down"; snapshotAt?: string; ageSeconds?: number; detail?: string };
  products: Product[];
  issues: ProductIssue[];
};
export type ProductsDeps = {
  projects(): Promise<{ projects: ProjectRecord[]; down?: string }>;
  declaration(project: ProjectRecord): Promise<{ raw?: string; commit: string }>;
  receipt(project: ProjectRecord): Promise<unknown>;
  now(): number;
};

async function git(repo: string, args: string[]) {
  const { stdout } = await exec("git", ["--no-replace-objects", "--no-optional-locks", "-C", repo, ...args], {
    timeout: 2500, maxBuffer: MAX_BYTES, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
  return stdout.trim();
}

export async function committedDeclaration(project: ProjectRecord) {
  if (!isAbsolute(project.repoPath)) throw Error("invalid repository path");
  const repo = await realpath(project.repoPath);
  const commit = await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw Error("invalid commit");
  const entry = await git(repo, ["ls-tree", commit, "--", ".launch.yaml"]);
  if (!entry) return { commit };
  if (!/^100(?:644|755) blob [a-f0-9]+\t\.launch\.yaml$/.test(entry)) throw Error("declaration must be a regular committed file");
  const raw = await git(repo, ["show", `${commit}:.launch.yaml`]);
  return { commit, raw };
}

export async function readPublication(project: ProjectRecord): Promise<unknown> {
  const pms = project.agents?.filter((a) => a.role === "pm");
  if (pms?.length !== 1 || !pms[0].roleDir || !safeRelPath(pms[0].roleDir)) throw Error("PM role directory unavailable");
  const repo = await realpath(project.repoPath);
  const path = await realpath(resolve(repo, pms[0].roleDir, "runtime/launch-dashboard.json"));
  const rel = relative(repo, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("receipt escapes registered repository");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    const openedRel = relative(repo, openedPath);
    if (!openedRel || openedRel.startsWith("..") || isAbsolute(openedRel)) throw Error("opened receipt escapes registered repository");
    if (!stat.isFile() || stat.size > MAX_BYTES) throw Error("receipt is not a bounded regular file");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) throw Error("receipt too large");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally { await handle.close(); }
}

export function defaultProductsDeps(projects: ProductsDeps["projects"]): ProductsDeps {
  return { projects, declaration: committedDeclaration, receipt: readPublication, now: Date.now };
}

export function createProductsDirectory(deps: ProductsDeps) {
  let lastGood: { at: number; projects: ProjectRecord[] } | undefined;
  let cached: { at: number; payload: ProductsPayload } | undefined;
  let inflight: Promise<ProductsPayload> | undefined;
  async function collect(): Promise<ProductsPayload> {
    const now = deps.now();
    let down = false;
    try {
      const read = await deps.projects();
      if (read.down) down = true;
      else lastGood = { at: now, projects: read.projects };
    } catch { down = true; }
    const products: Product[] = [];
    const issues: ProductIssue[] = [];
    // Bounded concurrency avoids one Git process per registered project at once.
    const projects = [...new Map((lastGood?.projects ?? []).map((p) => [p.id, p])).values()];
    for (let i = 0; i < projects.length; i += 4) {
      await Promise.all(projects.slice(i, i + 4).map(async (p) => {
        const issue = (state: ProductIssue["state"], detail: string) => issues.push({ id: p.id, name: p.name, state, detail });
        let decl: Awaited<ReturnType<ProductsDeps["declaration"]>>;
        try { decl = await deps.declaration(p); } catch { issue("unavailable", "Committed .launch.yaml could not be read."); return; }
        if (decl.raw === undefined) { issue("missing", "No committed .launch.yaml; lifecycle is unknown."); return; }
        const classification = classifyProduct(decl.raw);
        if (classification.steady) return;
        if (!classification.stage) { issue("invalid", classification.issue!); return; }
        const product: Product = { id: p.id, name: p.name, stage: classification.stage, declaration: { commit: decl.commit }, issue: classification.issue };
        if (product.stage === "live") product.destination = { href: "/live", label: "Open Live management" };
        else {
          try {
            product.destination = publication(await deps.receipt(p));
            if (!product.destination) product.issue = "Publication receipt is invalid or has an unsafe dashboard URL.";
          } catch { product.issue = "Publication receipt unavailable; no dashboard link can be resolved."; }
        }
        products.push(product);
      }));
    }
    products.sort((a, b) => a.name.localeCompare(b.name));
    issues.sort((a, b) => a.name.localeCompare(b.name));
    return {
      generatedAt: new Date(now).toISOString(),
      registry: { state: down ? "down" : "ok", ...(down ? { detail: "PJ registry unavailable or invalid. Lifecycle discovery is incomplete." } : {}),
        ...(lastGood ? { snapshotAt: new Date(lastGood.at).toISOString(), ageSeconds: Math.max(0, Math.floor((now - lastGood.at) / 1000)) } : {}) },
      products, issues
    };
  }
  return {
    async read(): Promise<ProductsPayload> {
      if (cached && deps.now() - cached.at < 5000) return cached.payload;
      if (inflight) return inflight;
      inflight = collect().then((payload) => { cached = { at: deps.now(), payload }; return payload; }).finally(() => { inflight = undefined; });
      return inflight;
    }
  };
}

export function registerProductsRoutes(app: FastifyInstance, directory: ReturnType<typeof createProductsDirectory>) {
  // Same edge-owned authentication boundary as the existing /api/modules/live/apps route.
  app.get("/api/modules/products", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return directory.read();
  });
}

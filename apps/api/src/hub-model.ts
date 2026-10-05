// Pure model behind the hub's Agents and Projects views. All IO lives in hub.ts;
// everything here takes plain inputs so the joins can be tested without a fleet.
//
// The join that matters most is agent -> pjangler project. No registry row stores
// a pjangler project_id, so an agent resolves to a project the way Flume's roster
// and pjangler's identity check do: project_path == repo_path first, then
// repo == project_id (case-insensitive), then the Plane board id. Anything else is
// reported as "no project record" rather than guessed.

export type Signal = "you" | "broken" | "stuck" | "working" | "quiet" | "cleared" | "unknown";

export type RegistryRow = {
  agentId: string;
  displayName: string;
  role: string;
  repo: string;
  projectPath: string;
  boardId?: string;
  boardIdentifier?: string;
  reportsTo?: string;
  gatewayUnit?: string;
  provisionedAt?: string;
};

export type ProjectRecord = {
  id: string;
  name: string;
  repoPath: string;
  status?: string;
  board?: string;
  boardId?: string;
  workspace?: string;
  indexed: boolean;
};

export type AsmRow = {
  scope: string;
  state: string;
  blockKind?: string;
  sinceMs?: number;
  lastMs?: number;
  subs?: number;
  tools?: number;
  turn?: number;
};

export type InvocationEvent = {
  id: string;
  type: "started" | "completed" | "failed";
  at: string;
  agentId?: string;
  invocationId: string;
  parentInvocationId?: string | null;
  ticketKey?: string;
  fromDirector?: boolean;
};

export type WorkerScope = {
  unit: string;
  description: string;
  activeSince?: string;
  active: boolean;
};

export type TicketEvent = {
  at: string;
  repo?: string;
  ticketId: string;
  ticketKey?: string;
  title?: string;
  phase?: string;
  band?: string;
  labels: string[];
};

export type Ticket = {
  key: string;
  title: string;
  band?: string;
  state?: string;
  labels: string[];
  updatedAt: string;
  repo?: string;
};

export type ProjectLink = ProjectRecord & { basis: "project_path" | "repo" | "board" };

export type HubAgent = {
  id: string;
  name: string;
  role: "director" | "pm";
  declaredRole: string;
  state: string;
  signal: Signal;
  blockKind?: string;
  heldSeconds?: number;
  lastActiveAt?: string;
  active: boolean;
  gateway: "active" | "inactive" | "unknown";
  project?: ProjectLink;
  reportsTo: string;
  reportsBasis: "recorded" | "inferred";
  ticket?: Ticket;
  subs?: number;
  tools?: number;
  turn?: number;
};

export type HubContractor = {
  id: string;
  parent: string;
  via: "subagent" | "scope";
  state: "open" | "running";
  ticket?: string;
  startedAt?: string;
  ref: string;
  description?: string;
};

export type HubEvent = {
  id: string;
  at: string;
  from: string;
  to: string;
  kind: "delegated" | "responded" | "failed";
  text: string;
};

const ASM_SIGNAL: Record<string, Signal> = {
  awaiting_human: "you",
  failed: "broken",
  stale: "stuck",
  gone: "unknown",
  delegating: "working",
  tool_running: "working",
  working: "working",
  starting: "working",
  idle: "quiet",
  unknown: "unknown"
};
const ACTIVE_STATES = new Set(["awaiting_human", "failed", "delegating", "tool_running", "working", "starting"]);

export function signalOf(state: string): Signal {
  return ASM_SIGNAL[state] ?? "unknown";
}

const trimSlash = (path: string) => path.replace(/\/+$/, "");
export function normalizePath(path: string | undefined, home = "/home/delorenj"): string {
  if (!path) return "";
  const expanded = path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
  return trimSlash(expanded);
}

export function isAncestor(parent: string, child: string): boolean {
  if (!parent || !child || parent === child) return false;
  return child.startsWith(`${parent}/`);
}

/** Agent -> project, in the order Flume and pjangler use. */
export function linkProject(agent: RegistryRow, projects: ProjectRecord[]): ProjectLink | undefined {
  const path = normalizePath(agent.projectPath);
  if (path.startsWith("/")) {
    const byPath = projects.find((p) => normalizePath(p.repoPath) === path);
    if (byPath) return { ...byPath, basis: "project_path" };
  }
  const repo = agent.repo.trim().toLowerCase();
  if (repo) {
    const byRepo = projects.find((p) => p.id.toLowerCase() === repo);
    if (byRepo) return { ...byRepo, basis: "repo" };
  }
  if (agent.boardId) {
    const byBoard = projects.find((p) => p.boardId && p.boardId === agent.boardId);
    if (byBoard) return { ...byBoard, basis: "board" };
  }
  return undefined;
}

/** A project is a parent when another project's repo sits inside it (the Director Rule). */
export function childProjects(parent: ProjectRecord, projects: ProjectRecord[]): ProjectRecord[] {
  const root = normalizePath(parent.repoPath);
  return projects.filter((p) => isAncestor(root, normalizePath(p.repoPath)));
}

function heldFrom(sinceMs: number | undefined, nowMs: number): number | undefined {
  if (!sinceMs || !Number.isFinite(sinceMs)) return undefined;
  return Math.max(0, Math.round((nowMs - sinceMs) / 1000));
}

/** Open subagents: invocation.started with a parent, closed oldest-first by the parent's completion. */
export function openSubagents(events: InvocationEvent[], nowMs: number, maxAgeMs = 2 * 3600_000): HubContractor[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const open = new Map<string, Array<{ e: InvocationEvent }>>();
  for (const e of sorted) {
    if (e.type === "started" && e.parentInvocationId && e.agentId) {
      const list = open.get(e.parentInvocationId) ?? [];
      list.push({ e });
      open.set(e.parentInvocationId, list);
    } else if (e.type !== "started") {
      // completed/failed carry the parent session id; close the oldest open child under it.
      const list = open.get(e.invocationId);
      if (list?.length) list.shift();
      // a child's own completion (when a runtime reports it) closes it directly
      for (const [parent, items] of open) {
        const idx = items.findIndex((item) => item.e.invocationId === e.invocationId);
        if (idx >= 0) items.splice(idx, 1);
        if (!items.length) open.delete(parent);
      }
    }
  }
  const out: HubContractor[] = [];
  for (const items of open.values()) {
    for (const { e } of items) {
      if (nowMs - Date.parse(e.at) > maxAgeMs) continue;
      out.push({
        id: `sub:${e.invocationId}`,
        parent: e.agentId!,
        via: "subagent",
        state: "open",
        ticket: e.ticketKey,
        startedAt: e.at,
        ref: `invocation ${e.invocationId.slice(0, 12)}`
      });
    }
  }
  return out;
}

const TICKET_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/;
const PROFILE_FLAG = /--profile[ =]([A-Za-z0-9_.-]+)/;

/** hermes-worker-proc scopes: the PM is only recoverable from --profile in the unit description. */
export function workerContractors(scopes: WorkerScope[], agentIds: Set<string>): HubContractor[] {
  const out: HubContractor[] = [];
  for (const scope of scopes) {
    if (!scope.active) continue;
    const parent = scope.description.match(PROFILE_FLAG)?.[1];
    if (!parent || !agentIds.has(parent)) continue;
    const fromFile = scope.description.match(/query-file\s+\S*?([a-z]+)[-_]?(\d{1,6})[^\s"]*/i);
    const key = scope.description.match(TICKET_KEY)?.[1] ?? (fromFile ? `${fromFile[1].toUpperCase()}-${fromFile[2]}` : undefined);
    out.push({
      id: `scope:${scope.unit}`,
      parent,
      via: "scope",
      state: "running",
      ticket: key,
      startedAt: scope.activeSince,
      ref: scope.unit,
      description: scope.description
    });
  }
  return out;
}

/** Latest known state of every ticket, keyed by ticket key (or id when Plane gave no key). */
export function projectTickets(events: TicketEvent[]): Map<string, Ticket> {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const byId = new Map<string, Ticket>();
  for (const e of sorted) {
    const id = e.ticketKey ?? e.ticketId;
    const prior = byId.get(id);
    byId.set(id, {
      key: e.ticketKey ?? prior?.key ?? e.ticketId.slice(0, 8),
      title: e.title ?? prior?.title ?? id,
      band: e.band ?? prior?.band,
      state: e.phase ?? prior?.state,
      labels: e.labels.length ? e.labels : prior?.labels ?? [],
      updatedAt: e.at,
      repo: e.repo ?? prior?.repo
    });
  }
  return byId;
}

export type AgentInputs = {
  nowMs: number;
  registry: RegistryRow[];
  projects: ProjectRecord[];
  asm: Map<string, AsmRow>;
  gateways: Map<string, "active" | "inactive">;
  invocations: InvocationEvent[];
  scopes: WorkerScope[];
  tickets: Map<string, Ticket>;
};

export type AgentsModel = {
  agents: HubAgent[];
  contractors: HubContractor[];
  events: HubEvent[];
  stats: { agents: number; active: number; noProject: number; contractors: number; waiting: number };
};

export function buildAgents(input: AgentInputs): AgentsModel {
  const { nowMs, registry, projects } = input;
  const links = new Map(registry.map((r) => [r.agentId, linkProject(r, projects)]));
  const directorIds = new Set(
    registry
      .filter((r) => {
        if (r.role === "director") return true;
        const link = links.get(r.agentId);
        return !!link && childProjects(link, projects).length > 0;
      })
      .map((r) => r.agentId)
  );

  const ids = new Set(registry.map((r) => r.agentId));
  const contractors = [...openSubagents(input.invocations, nowMs), ...workerContractors(input.scopes, ids)].filter((c) =>
    ids.has(c.parent)
  );
  const contractorsByParent = new Map<string, HubContractor[]>();
  for (const c of contractors) contractorsByParent.set(c.parent, [...(contractorsByParent.get(c.parent) ?? []), c]);

  // The most recent ticket a gateway invocation handed each agent.
  const lastTicket = new Map<string, { key: string; at: string }>();
  const lastSeen = new Map<string, string>();
  for (const e of input.invocations) {
    if (!e.agentId) continue;
    if (!lastSeen.get(e.agentId) || Date.parse(e.at) > Date.parse(lastSeen.get(e.agentId)!)) lastSeen.set(e.agentId, e.at);
    if (e.type === "started" && !e.parentInvocationId && e.ticketKey) {
      const prior = lastTicket.get(e.agentId);
      if (!prior || Date.parse(e.at) > Date.parse(prior.at)) lastTicket.set(e.agentId, { key: e.ticketKey, at: e.at });
    }
  }

  const agents: HubAgent[] = registry.map((r) => {
    const asm = input.asm.get(`hermes:a:${r.agentId}`);
    const gateway = input.gateways.get(r.gatewayUnit ?? `hermes-${r.agentId}-gateway.service`) ?? "unknown";
    const kids = contractorsByParent.get(r.agentId) ?? [];
    let state = asm?.state ?? (gateway === "inactive" ? "gone" : "unknown");
    if (kids.length && (state === "idle" || state === "working" || state === "unknown")) state = "delegating";
    const link = links.get(r.agentId);
    const directorAbove = [...directorIds]
      .filter((d) => d !== r.agentId)
      .map((d) => ({ id: d, link: links.get(d) }))
      .filter((d) => d.link && link && isAncestor(normalizePath(d.link.repoPath), normalizePath(link.repoPath)))
      .sort((a, b) => normalizePath(b.link!.repoPath).length - normalizePath(a.link!.repoPath).length)[0];
    const reportsTo = r.reportsTo && (ids.has(r.reportsTo) || r.reportsTo === "ceo") ? r.reportsTo : directorAbove?.id ?? "ceo";
    const ticketKey = lastTicket.get(r.agentId)?.key ?? kids.find((k) => k.ticket)?.ticket;
    // The ASM sweeper rewrites last_ms on every pass, so it says when the scope was last
    // looked at, not when it last did anything. Outside an active state, `since` (when it
    // went idle, or was first found) is the honest recency; inside one, it is active now.
    const asmActiveMs = !asm ? 0 : ACTIVE_STATES.has(asm.state) ? asm.lastMs ?? nowMs : asm.sinceMs ?? 0;
    const lastActiveMs = Math.max(asmActiveMs, Date.parse(lastSeen.get(r.agentId) ?? "") || 0);
    return {
      id: r.agentId,
      name: r.displayName || r.agentId,
      role: directorIds.has(r.agentId) ? "director" : "pm",
      declaredRole: r.role || "pm",
      state,
      signal: signalOf(state),
      blockKind: asm?.blockKind || undefined,
      heldSeconds: heldFrom(asm?.sinceMs, nowMs),
      lastActiveAt: lastActiveMs ? new Date(lastActiveMs).toISOString() : r.provisionedAt,
      active: ACTIVE_STATES.has(state) || kids.length > 0,
      gateway,
      project: link,
      reportsTo,
      reportsBasis: r.reportsTo && reportsTo === r.reportsTo ? "recorded" : "inferred",
      ticket: ticketKey ? input.tickets.get(ticketKey) ?? { key: ticketKey, title: ticketKey, labels: [], updatedAt: "" } : undefined,
      subs: asm?.subs,
      tools: asm?.tools,
      turn: asm?.turn
    };
  });

  // Delegation dots: a parented start goes down to a contractor, a gateway start goes down from
  // the agent's boss, and completions and failures go back up the same lines.
  const contractorByInvocation = new Map(contractors.filter((c) => c.via === "subagent").map((c) => [c.id.slice(4), c]));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const recent = input.invocations.filter((e) => nowMs - Date.parse(e.at) < 10 * 60_000);
  const events: HubEvent[] = [];
  for (const e of recent) {
    if (!e.agentId || !byId.has(e.agentId)) continue;
    const agent = byId.get(e.agentId)!;
    if (e.type === "started" && e.parentInvocationId) {
      const child = contractorByInvocation.get(e.invocationId);
      if (child) events.push({ id: e.id, at: e.at, from: agent.id, to: child.id, kind: "delegated", text: `${agent.name} opened a subagent${e.ticketKey ? ` for ${e.ticketKey}` : ""}` });
      continue;
    }
    if (e.type === "started") {
      events.push({ id: e.id, at: e.at, from: agent.reportsTo, to: agent.id, kind: "delegated", text: `${agent.name} picked up ${e.ticketKey ?? "work"}` });
    } else {
      events.push({
        id: e.id, at: e.at, from: agent.id, to: agent.reportsTo,
        kind: e.type === "failed" ? "failed" : "responded",
        text: `${agent.name} ${e.type === "failed" ? "failed" : "finished"} ${e.ticketKey ?? "a run"}`
      });
    }
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return {
    agents,
    contractors,
    events: events.slice(-40),
    stats: {
      agents: agents.length,
      active: agents.filter((a) => a.active).length,
      noProject: agents.filter((a) => !a.project).length,
      contractors: contractors.length,
      waiting: agents.filter((a) => a.signal === "you").length
    }
  };
}

// ---------------------------------------------------------------------------
// Projects

export type Component = { id: string; name: string; repoPath: string; role?: string; description?: string };

export type EdgeSpec = { from: string; to: string; label: string; detail: string; kind: string; dashed?: boolean };

export type HubProject = {
  id: string;
  name: string;
  kind: "parent" | "component" | "outside" | "island" | "external";
  projectId?: string;
  board?: string;
  workspace?: string;
  repoPath?: string;
  status?: string;
  indexed: boolean;
  registered: boolean;
  what?: string;
  pm?: { id: string; name: string; state: string; signal: Signal; heldSeconds?: number; basis: string };
  tickets: Ticket[];
};

/** Interfaces between platform components, read from code: subjects, ports, files, packages. */
export const COMPONENT_EDGES: EdgeSpec[] = [
  { from: "candystore", to: "bloodbank", label: "evt.> via Dapr", detail: "bloodbank.evt.> · Dapr subscription, durable candystore-events", kind: "NATS" },
  { from: "holocene", to: "bloodbank", label: "evt.> JetStream", detail: "bloodbank.evt.> · ephemeral JetStream consumer, plus Redis stat keys", kind: "NATS" },
  { from: "hermes-fleet", to: "bloodbank", label: "invocation.start", detail: "bloodbank.cmd.agent.invocation.start · durable bloodbank-hermes-gateway", kind: "NATS" },
  { from: "krebs", to: "bloodbank", label: "lifecycle.task.invoke", detail: "bloodbank.cmd.lifecycle.task.invoke · installed, disabled", kind: "NATS", dashed: true },
  { from: "n8n", to: "bloodbank", label: "repo.task.* · cmd", detail: "publishes repo.task.* · sends cmd.agent.invocation.start", kind: "NATS" },
  { from: "holocene", to: "candystore", label: "HTTP :8683", detail: "HTTP 127.0.0.1:8683 /events", kind: "HTTP" },
  { from: "holocene", to: "hermes-fleet", label: "registry file", detail: "agents-registry.yaml · gateway units", kind: "file" },
  { from: "holocene", to: "pjangler", label: ":8764 registry", detail: "GET :8764/v1/registry · agent to project join", kind: "HTTP" },
  { from: "pjangler", to: "hermes-fleet", label: "pj identity", detail: "pj identity --apply · writes plane.* into the registry", kind: "file" },
  { from: "flume", to: "pjangler", label: ":8764 registry", detail: "GET :8764/v1/registry · roster", kind: "HTTP" },
  { from: "flume", to: "hermes-fleet", label: "provisioner", detail: "hire · provisioner writes registry rows", kind: "file" },
  { from: "krebs", to: "pjangler", label: ".project.json", detail: ".project.json · ticket_provider and execution", kind: "file" },
  { from: "momo", to: "krebs", label: "lifecycle spec", detail: "lifecycle.v1.yaml · documented only", kind: "spec", dashed: true },
  { from: "pjangler", to: "skillex", label: "npm", detail: "npm @delorenj/skillex", kind: "npm" },
  { from: "flume", to: "skillex", label: "npm", detail: "npm @delorenj/skillex", kind: "npm" },
  { from: "n8n", to: "pjangler", label: ":8764 registry", detail: "GET :8764/v1/registry · board to repo", kind: "HTTP" },
  { from: "plane", to: "n8n", label: "webhook", detail: "webhook n8n.delo.sh/webhook/plane", kind: "HTTP" }
];

const EXTERNALS: HubProject[] = [
  { id: "n8n", name: "n8n", kind: "external", indexed: false, registered: false, tickets: [], what: "Runs the Plane ticket workflows and routes each board to its project through the pjangler registry." },
  { id: "plane", name: "Plane", kind: "external", indexed: false, registered: false, tickets: [], what: "Where tickets live. Each project binds one board through ticket_provider in .project.json." }
];

export type ProjectInputs = {
  rootPath: string;
  components: Component[];
  projects: ProjectRecord[];
  agents: HubAgent[];
  tickets: Map<string, Ticket>;
};

export function buildProjects(input: ProjectInputs): { projects: HubProject[]; edges: EdgeSpec[] } {
  const root = normalizePath(input.rootPath);
  const pmByProject = new Map<string, HubAgent>();
  for (const a of input.agents) {
    if (!a.project) continue;
    const prior = pmByProject.get(a.project.id);
    if (!prior || (a.role === "director" && prior.role !== "director")) pmByProject.set(a.project.id, a);
  }
  const ticketsFor = (project: ProjectRecord | undefined): Ticket[] => {
    if (!project) return [];
    const out = [...input.tickets.values()].filter(
      (t) => (t.repo && t.repo.toLowerCase() === project.id) || (project.board && t.key.startsWith(`${project.board}-`))
    );
    return out
      .filter((t) => t.band === "started" || t.band === "unstarted")
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 6);
  };
  const pmOf = (project: ProjectRecord | undefined): HubProject["pm"] => {
    const pm = project ? pmByProject.get(project.id) : undefined;
    return pm
      ? { id: pm.id, name: pm.name, state: pm.state, signal: pm.signal, heldSeconds: pm.heldSeconds, basis: pm.project!.basis }
      : undefined;
  };
  const toNode = (project: ProjectRecord | undefined, base: Partial<HubProject> & Pick<HubProject, "id" | "name" | "kind">): HubProject => ({
    ...base,
    projectId: project?.id,
    board: project?.board,
    workspace: project?.workspace,
    repoPath: project?.repoPath ?? base.repoPath,
    status: project?.status,
    indexed: !!project?.indexed,
    registered: !!project,
    pm: pmOf(project),
    tickets: ticketsFor(project)
  });

  const used = new Set<string>();
  const nodes: HubProject[] = [];
  const parent = input.projects.find((p) => normalizePath(p.repoPath) === root);
  if (parent) {
    used.add(parent.id);
    nodes.push(toNode(parent, { id: parent.id, name: parent.name, kind: "parent" }));
  }
  for (const c of input.components) {
    const path = normalizePath(c.repoPath);
    const project = input.projects.find((p) => normalizePath(p.repoPath) === path);
    if (project) used.add(project.id);
    nodes.push(
      toNode(project, {
        id: c.id,
        name: c.name,
        kind: isAncestor(root, path) ? "component" : "outside",
        repoPath: path,
        what: c.description
      })
    );
  }
  for (const p of input.projects) {
    if (used.has(p.id)) continue;
    const nested = isAncestor(root, normalizePath(p.repoPath));
    nodes.push(toNode(p, { id: p.id, name: p.name, kind: nested ? "component" : "island" }));
  }
  nodes.push(...EXTERNALS.map((e) => ({ ...e })));
  const known = new Set(nodes.map((n) => n.id));
  return { projects: nodes, edges: COMPONENT_EDGES.filter((e) => known.has(e.from) && known.has(e.to)) };
}

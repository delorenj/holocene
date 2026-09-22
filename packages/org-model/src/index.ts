// @holocene/org-model — shared org-chart vocabulary + the pure resolver that
// turns (org.yaml + agent registry + live fleet state) into a rendered tree.
//
// Adopts Flume's Employee/Manager/Contributor status vocabulary (see
// DeLoDocs .../flume-technical.md) so the eventual v2 delegation layer slots in
// without a remodel. This module is PURE: no fs, no fetch, no clock — the API
// layer does the IO and hands merge() plain data so it stays trivially testable
// and identically usable from both apps/api and apps/web.

// ---- Flume vocabulary -------------------------------------------------------

export type EmployeeRole = "manager" | "contributor";

// Flume EmployeeStatus string values, plus "unknown" for agents with no live
// state yet (the plan's OrgNode.status = EmployeeStatus | 'unknown').
export type EmployeeStatus =
  | "initializing"
  | "onboarding"
  | "idle"
  | "working"
  | "blocked"
  | "failed"
  | "unknown";

// Raw busy_state as reported by the Holocene fleet snapshot.
export type BusyState = "idle" | "busy" | "blocked" | "stalled" | "error" | "unknown";

// ---- Resolved tree node the Mini App renders -------------------------------

export type NodeFlag = "new-hire" | "unassigned" | "no-heartbeat" | "shipped-recent";

export type LiveAgentState = {
  agentId: string;
  busyState: BusyState;
  activeWork?: {
    status?: string;
    issueId?: string;
    summary?: string;
    reason?: string;
    lastHeartbeatAt?: string;
    ageSeconds?: number;
  };
  sparkline?: number[]; // recent per-day ticket-velocity counts (oldest → newest)
  updatedAt?: string;
};

export type AgentRef = {
  agentId: string;
  repo: string;
  projectPath: string;
  botUsername?: string;
  planeIdentifier?: string;
};

export type OrgNode = {
  id: string; // 'ceo' | 'dept:<id>' | agent_id
  kind: "ceo" | "department" | "agent";
  employeeRole?: EmployeeRole;
  displayName: string;
  title: string;
  order: number;
  status: EmployeeStatus;
  agentRef?: AgentRef; // deep-link + badge (agents only)
  live?: LiveAgentState; // live overlay (agents only; undefined until first state)
  rollup?: { agents: number; working: number; needsAttention: number }; // ceo/department nodes
  metadata?: { expertise: string[]; teamId: string };
  flags?: NodeFlag[];
  children: OrgNode[];
};

// ---- org.yaml shape (hand-edited by the operator) --------------------------

export type OrgPersona = { title?: string; expertise?: string[]; avatar?: string };

export type OrgDepartment = {
  id: string;
  name: string;
  order?: number;
  manager?: string | null; // agent_id or null
  members?: string[]; // agent_ids
};

export type OrgConfig = {
  version?: number;
  company?: { name?: string; handle?: string };
  ceo?: { id?: string; display_name?: string; title?: string; telegram_user?: string };
  personas?: Record<string, OrgPersona>;
  departments?: OrgDepartment[];
  defaults?: { unassigned_department?: { id?: string; name?: string; order?: number } };
  hidden?: string[]; // agent_ids to omit entirely
};

// ---- inputs the API projects the registry + snapshot into ------------------

export type RegistryAgent = {
  agentId: string;
  repo: string;
  displayName: string;
  projectPath: string;
  botUsername?: string;
  planeIdentifier?: string;
};

export type MergeInput = {
  config?: OrgConfig;
  agents: RegistryAgent[];
  live?: Record<string, LiveAgentState>;
  generatedAt: string;
  source: string;
};

export type OrgTree = {
  generatedAt: string;
  source: string;
  company: { name: string; handle?: string };
  root: OrgNode; // CEO node; children = departments
  unmapped: string[]; // agent_ids that landed in the Unassigned bucket
  totals: { agents: number; working: number; idle: number; needsAttention: number; unknown: number };
};

// ---- resolver --------------------------------------------------------------

function statusFromBusy(busy?: BusyState): EmployeeStatus {
  switch (busy) {
    case "busy":
      return "working";
    case "idle":
      return "idle";
    case "blocked":
    case "stalled":
      return "blocked";
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

function needsAttention(status: EmployeeStatus): boolean {
  return status === "blocked" || status === "failed";
}

// child.projectPath is nested beneath parent.projectPath (directory boundary).
function isAncestorPath(parent: string, child: string): boolean {
  if (!parent || !child || child.length <= parent.length) return false;
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(prefix);
}

type DeptDef = { id: string; name: string; order: number; managerId?: string; memberIds: string[] };

/**
 * Resolve the org chart. org.yaml wins; project_path nesting fills gaps for
 * agents the operator hasn't placed yet; anything left over falls into an
 * "Unassigned" bucket so the chart never breaks on registry drift.
 */
export function merge(input: MergeInput): OrgTree {
  const { config, agents, live = {}, generatedAt, source } = input;

  const company = {
    name: config?.company?.name ?? "Company",
    handle: config?.company?.handle
  };

  const hidden = new Set((config?.hidden ?? []).filter((x): x is string => typeof x === "string"));
  const personas = config?.personas ?? {};

  // Visible registry agents, keyed by id.
  const byId = new Map<string, RegistryAgent>();
  for (const a of agents) {
    if (a?.agentId && !hidden.has(a.agentId)) byId.set(a.agentId, a);
  }

  const depts = new Map<string, DeptDef>();
  const configPlaced = new Map<string, string>(); // agentId -> deptId (from org.yaml only)
  const referenced = new Set<string>(); // agentIds named anywhere in org.yaml
  const cfgDepartments = config?.departments ?? [];

  // Seed department defs.
  cfgDepartments.forEach((d, i) => {
    if (!d?.id) return;
    depts.set(d.id, {
      id: d.id,
      name: d.name ?? d.id,
      order: typeof d.order === "number" ? d.order : i,
      memberIds: []
    });
  });

  // Pass 1: managers (claimed before any member slot to avoid double-placement).
  for (const d of cfgDepartments) {
    if (!d?.id || !d.manager) continue;
    referenced.add(d.manager);
    const dept = depts.get(d.id);
    if (!dept) continue;
    if (byId.has(d.manager) && !configPlaced.has(d.manager)) {
      dept.managerId = d.manager;
      configPlaced.set(d.manager, d.id);
    }
  }

  // Pass 2: members.
  for (const d of cfgDepartments) {
    if (!d?.id) continue;
    const dept = depts.get(d.id);
    if (!dept) continue;
    for (const m of d.members ?? []) {
      referenced.add(m);
      if (!byId.has(m) || configPlaced.has(m)) continue; // unknown/hidden, or first placement wins
      dept.memberIds.push(m);
      configPlaced.set(m, d.id);
    }
  }

  // Derivation + unassigned bucket for everything org.yaml didn't place.
  const unassignedDef = config?.defaults?.unassigned_department ?? {};
  const unassignedId = unassignedDef.id ?? "unassigned";
  const unassignedName = unassignedDef.name ?? "Unassigned";
  const unassignedOrder = typeof unassignedDef.order === "number" ? unassignedDef.order : 999;
  const unmapped: string[] = [];

  for (const a of byId.values()) {
    if (configPlaced.has(a.agentId)) continue;

    // Co-locate by project_path: prefer nesting under the deepest configured
    // ancestor directory, else share a department with a configured agent in the
    // SAME directory (e.g. a repo's PM + scrum-master sharing one project_path).
    let best: { deptId: string; depth: number } | undefined;
    let samePathDept: string | undefined;
    for (const [otherId, deptId] of configPlaced.entries()) {
      const other = byId.get(otherId);
      if (!other || !other.projectPath || !a.projectPath) continue;
      if (other.projectPath === a.projectPath) {
        samePathDept ??= deptId;
        continue;
      }
      if (!isAncestorPath(other.projectPath, a.projectPath)) continue;
      const depth = other.projectPath.length;
      if (!best || depth > best.depth) best = { deptId, depth };
    }

    const targetDept = best?.deptId ?? samePathDept;
    if (targetDept) {
      depts.get(targetDept)!.memberIds.push(a.agentId);
      continue;
    }

    if (!depts.has(unassignedId)) {
      depts.set(unassignedId, { id: unassignedId, name: unassignedName, order: unassignedOrder, memberIds: [] });
    }
    depts.get(unassignedId)!.memberIds.push(a.agentId);
    unmapped.push(a.agentId);
  }

  const buildAgentNode = (agentId: string, role: EmployeeRole, order: number, deptId: string): OrgNode | undefined => {
    const reg = byId.get(agentId);
    if (!reg) return undefined;
    const liveState = live[agentId];
    const status = statusFromBusy(liveState?.busyState);
    const persona = personas[agentId] ?? {};
    const flags: NodeFlag[] = [];
    if (deptId === unassignedId) flags.push("unassigned");
    if (!referenced.has(agentId)) flags.push("new-hire");
    if (!liveState || liveState.busyState === "unknown") flags.push("no-heartbeat");
    return {
      id: agentId,
      kind: "agent",
      employeeRole: role,
      displayName: reg.displayName || agentId,
      title: persona.title ?? (role === "manager" ? "Manager" : "Project Manager"),
      order,
      status,
      agentRef: {
        agentId,
        repo: reg.repo,
        projectPath: reg.projectPath,
        botUsername: reg.botUsername,
        planeIdentifier: reg.planeIdentifier
      },
      live: liveState,
      metadata: { expertise: persona.expertise ?? [], teamId: deptId },
      flags: flags.length ? flags : undefined,
      children: []
    };
  };

  let totalAgents = 0;
  let totalWorking = 0;
  let totalIdle = 0;
  let totalAttention = 0;
  let totalUnknown = 0;

  const deptNodes: OrgNode[] = [];
  const sortedDepts = [...depts.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  for (const d of sortedDepts) {
    const children: OrgNode[] = [];
    let order = 0;
    if (d.managerId) {
      const node = buildAgentNode(d.managerId, "manager", order++, d.id);
      if (node) children.push(node);
    }
    for (const m of d.memberIds) {
      const node = buildAgentNode(m, "contributor", order++, d.id);
      if (node) children.push(node);
    }
    if (children.length === 0) continue;

    let working = 0;
    let idle = 0;
    let attention = 0;
    let unknown = 0;
    for (const c of children) {
      if (c.status === "working") working += 1;
      else if (c.status === "idle") idle += 1;
      else if (c.status === "unknown") unknown += 1;
      if (needsAttention(c.status)) attention += 1;
    }
    totalAgents += children.length;
    totalWorking += working;
    totalIdle += idle;
    totalAttention += attention;
    totalUnknown += unknown;

    deptNodes.push({
      id: `dept:${d.id}`,
      kind: "department",
      displayName: d.name,
      title: "",
      order: d.order,
      status: attention > 0 ? "blocked" : working > 0 ? "working" : "idle",
      rollup: { agents: children.length, working, needsAttention: attention },
      children
    });
  }

  const ceoCfg = config?.ceo ?? {};
  const root: OrgNode = {
    id: ceoCfg.id ?? "ceo",
    kind: "ceo",
    displayName: ceoCfg.display_name ?? "Operator",
    title: ceoCfg.title ?? "Operator / CEO",
    order: 0,
    status: totalAttention > 0 ? "blocked" : totalWorking > 0 ? "working" : "idle",
    rollup: { agents: totalAgents, working: totalWorking, needsAttention: totalAttention },
    children: deptNodes
  };

  return {
    generatedAt,
    source,
    company,
    root,
    unmapped,
    totals: {
      agents: totalAgents,
      working: totalWorking,
      idle: totalIdle,
      needsAttention: totalAttention,
      unknown: totalUnknown
    }
  };
}

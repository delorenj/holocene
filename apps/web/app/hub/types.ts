// Payloads of /api/modules/hub/agents and /api/modules/hub/projects (apps/api/src/hub.ts).

export type Signal = "you" | "broken" | "stuck" | "working" | "quiet" | "cleared" | "unknown";

export type Source = { name: string; value?: string; ageSeconds?: number; maxSeconds?: number; down?: boolean; detail?: string };

export type Ticket = { key: string; title: string; band?: string; state?: string; labels: string[]; updatedAt: string; repo?: string };

export type ProjectLink = {
  id: string;
  name: string;
  repoPath: string;
  status?: string;
  board?: string;
  boardId?: string;
  workspace?: string;
  indexed: boolean;
  basis: "project_path" | "repo" | "board";
};

export type Agent = {
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
  evidence: Evidence[];
};

export type Evidence = {
  cli?: string;
  cwd?: string;
  basis: "profile" | "project" | "related";
  state: "idle" | "done" | "active" | "error" | "hitl";
  heldSeconds?: number;
  lastAt?: string;
  lastType?: string;
  subagents: number;
};

export type Contractor = {
  id: string;
  parent: string;
  via: "subagent" | "scope";
  state: "open" | "running";
  ticket?: string;
  startedAt?: string;
  ref: string;
  description?: string;
  eventId?: string;
  invocationId?: string;
  cli?: string;
  cwd?: string;
  receipt?: { invocationId: string; native: string; status: string; publishStatus?: string };
};

export type HubEvent = { id: string; at: string; from: string; to: string; kind: "delegated" | "responded" | "failed"; text: string };

export type AgentsPayload = {
  generatedAt: string;
  sources: Source[];
  agents: Agent[];
  contractors: Contractor[];
  events: HubEvent[];
  stats: { agents: number; active: number; noProject: number; contractors: number; waiting: number };
};

export type Project = {
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

export type Edge = { from: string; to: string; label: string; detail: string; kind: string; dashed?: boolean };

export type ProjectsPayload = { generatedAt: string; sources: Source[]; rootPath: string; projects: Project[]; edges: Edge[] };

// Who is doing what, from the Bloodbank event collection alone.
//
// This replaces the hub's trust in the ASM Redis `state` field, which cannot tell "working
// now" from "last said working two weeks ago": its counters only reset on a turn boundary, so
// one missed `quiesce` pins an agent at `working` forever. Deckard never has that problem
// because it reads evidence with an age. This module does the same (see deckard-state.ts).
//
// Pure: events and a resolver in, per-agent readings out.

import { HELD_WINDOW_MS, activityOf, emptyLatch, foldEvent, readLatch, rankOf, type DeckardState, type Latch, type Reading } from "./deckard-state.js";

export type ActivityEvent = {
  id: string;
  type: string;
  atMs: number;
  cli?: string;
  actorType?: string;
  actorAgent?: string;
  producer?: string;
  correlationId?: string;
  cwd?: string;
  pane?: string;
  session?: string;
  outcome?: string;
  invocationId?: string;
  parentInvocationId?: string;
};

/**
 * `profile`: a Hermes agent's own event. `project`: a session working inside the agent's project.
 * `related`: work happening beneath this agent (a director above the project, or a peer on it).
 * Related work only counts while it is live, and it never hands the agent subagent children.
 */
export type Owner = { agentId: string; basis: "profile" | "project" | "related" };

export type SessionEvidence = {
  key: string;
  basis: Owner["basis"];
  cli?: string;
  cwd?: string;
  pane?: string;
  state: DeckardState;
  sinceMs?: number;
  lastMs: number;
  lastType?: string;
  subagents: number;
};

export type OpenSubagent = {
  invocationId: string;
  parentInvocationId: string;
  /** Bloodbank event id of the `agent.invocation.started` fact the hook hub published. */
  eventId: string;
  parent: string;
  sessionKey: string;
  startedMs: number;
  cli?: string;
  cwd?: string;
  pane?: string;
};

export type AgentActivity = {
  reading: Reading;
  sessions: SessionEvidence[];
  subagents: OpenSubagent[];
};

type Session = {
  owner: Owner;
  key: string;
  latch: Latch;
  cli?: string;
  cwd?: string;
  pane?: string;
  children: OpenSubagent[];
};

// A turn can finish while its subagents keep running (a dynamic workflow's `Stop` fires within a
// minute and the subagents report back half an hour later), so only a session end or a failure
// leaves no subagent behind. A finished turn does not.
const ENDS_SUBAGENTS: ReadonlySet<string> = new Set(["session-ended", "failed"]);

/** Which running session an event belongs to, independent of which agent that turns out to be. */
function rawSessionOf(e: ActivityEvent): string {
  const cli = e.cli ?? "agent";
  if (e.producer?.startsWith("hermes-agent:")) return `${e.producer}:${e.correlationId ?? "main"}`;
  if (e.session && e.pane) return `${cli}:zellij:${e.session}:${e.pane}`;
  return `${cli}:${e.correlationId ?? e.cwd ?? "unknown"}`;
}

export function foldActivity(
  events: ActivityEvent[],
  resolve: (e: ActivityEvent) => Owner[],
  nowMs: number
): Map<string, AgentActivity> {
  const ordered = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.atMs - b.e.atMs || a.i - b.i).map((x) => x.e);

  // A session belongs to whoever owns the place it is working now. When it moves directories its
  // earlier events move with it, so a finished project does not keep pulsing for a session that left.
  const raw = new Map<string, ActivityEvent[]>();
  for (const e of ordered) {
    if (!activityOf(e.type, e.cli, e.outcome)) continue;
    const key = rawSessionOf(e);
    raw.set(key, [...(raw.get(key) ?? []), e]);
  }

  const sessions: Session[] = [];
  for (const [rawKey, list] of raw) {
    const newest = [...list].reverse().find((e) => e.cwd || e.producer?.startsWith("hermes-agent:")) ?? list[list.length - 1];
    for (const owner of resolve(newest)) {
      const s: Session = { owner, key: rawKey, latch: emptyLatch(), children: [] };
      for (const e of list) {
        const activity = activityOf(e.type, e.cli, e.outcome)!;
        s.cli = e.cli ?? s.cli;
        s.cwd = e.cwd ?? s.cwd;
        s.pane = e.pane ?? s.pane;
        s.latch = foldEvent(s.latch, { at: e.atMs, activity, type: e.type });
        if (e.type.endsWith("agent.invocation.started") && e.invocationId && e.parentInvocationId && e.invocationId !== e.parentInvocationId) {
          s.children.push({
            invocationId: e.invocationId, parentInvocationId: e.parentInvocationId, eventId: e.id, parent: owner.agentId,
            sessionKey: rawKey, startedMs: e.atMs, cli: e.cli, cwd: e.cwd, pane: e.pane
          });
        } else if (e.type.endsWith("agent.invocation.completed") && e.invocationId) {
          // Claude's SubagentStop carries the parent session id, not the subagent's: close the oldest child under it.
          const own = s.children.findIndex((c) => c.invocationId === e.invocationId);
          const orphan = own >= 0 ? own : s.children.findIndex((c) => c.parentInvocationId === e.invocationId);
          if (orphan >= 0) s.children.splice(orphan, 1);
        }
        if (ENDS_SUBAGENTS.has(activity)) s.children = [];
      }
      sessions.push(s);
    }
  }

  const byAgent = new Map<string, AgentActivity>();
  for (const s of sessions) {
    let reading = readLatch(s.latch, nowMs, s.children.length > 0);
    if (s.children.length && nowMs - s.latch.lastMs > HELD_WINDOW_MS) {
      // Nothing from this session for longer than the held ceiling: the subagents never reported back.
      s.children = [];
      reading = readLatch(s.latch, nowMs, false);
    }
    if (s.children.length && (reading.state === "done" || reading.state === "idle")) {
      // Open subagents are work in flight, whatever the parent turn said.
      reading = { ...reading, state: "active", sinceMs: Math.min(...s.children.map((c) => c.startedMs)) };
    }
    // Work beneath an agent only counts while it is live: a peer or a child project finishing a turn
    // says nothing about this agent, and its failures belong to the project that raised them.
    if (s.owner.basis === "related" && reading.state !== "active") continue;
    const evidence: SessionEvidence = {
      key: s.key, basis: s.owner.basis, cli: s.cli, cwd: s.cwd, pane: s.pane, state: reading.state,
      sinceMs: reading.sinceMs, lastMs: reading.lastMs, lastType: reading.lastType, subagents: s.children.length
    };
    const prior = byAgent.get(s.owner.agentId);
    const merged: AgentActivity = prior ?? { reading: { state: "idle", lastMs: 0 }, sessions: [], subagents: [] };
    merged.sessions.push(evidence);
    // Related work keeps the director pulsing while subagents run beneath it, but the subagents
    // belong to the project's own PM, so only a profile or project owner lists them as children.
    if (s.owner.basis !== "related") merged.subagents.push(...s.children);
    byAgent.set(s.owner.agentId, merged);
  }

  for (const a of byAgent.values()) {
    let state: DeckardState = "idle";
    for (const s of a.sessions) if (rankOf(s.state) > rankOf(state)) state = s.state;
    const winners = a.sessions.filter((s) => s.state === state && s.sinceMs !== undefined);
    const newest = [...a.sessions].sort((x, y) => y.lastMs - x.lastMs)[0];
    a.reading = {
      state,
      sinceMs: winners.length ? Math.min(...winners.map((s) => s.sinceMs!)) : undefined,
      lastMs: newest?.lastMs ?? 0,
      lastType: newest?.lastType
    };
    a.sessions.sort((x, y) => rankOf(y.state) - rankOf(x.state) || y.lastMs - x.lastMs);
    a.subagents.sort((x, y) => x.startedMs - y.startedMs);
  }
  return byAgent;
}

// ---------------------------------------------------------------- ownership

export type AgentPath = { agentId: string; path: string; role?: string };

const INFRASTRUCTURE_ACTORS: ReadonlySet<string> = new Set(["service", "ticket_provider"]);
const GENERIC_AGENT = "bloodbank.agent.";

/** The Hermes profile an event speaks for (deckard-approve `hermes_profile`). */
export function hermesProfileOf(e: ActivityEvent): string | undefined {
  if (e.producer?.startsWith("hermes-agent:")) return e.producer.slice("hermes-agent:".length) || undefined;
  if (e.cli === "hermes" && e.actorAgent && !e.actorAgent.startsWith(GENERIC_AGENT)) return e.actorAgent;
  return undefined;
}

const under = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);

/**
 * Deckard's agent-to-project rule: the longest repo path that contains the working directory owns
 * the work, and a Hermes agent owns its own profile's events. Every agent whose project sits above
 * the work (the director of a parent project) is related to it.
 */
export function ownerResolver(agents: AgentPath[]): (e: ActivityEvent) => Owner[] {
  const placed = agents.filter((a) => a.path.startsWith("/")).map((a) => ({ ...a, path: a.path.replace(/\/+$/, "") }));
  const ids = new Set(agents.map((a) => a.agentId));
  const above = (anchor: string, skip: Set<string>): Owner[] =>
    placed.filter((a) => !skip.has(a.agentId) && a.path.length < anchor.length && under(a.path, anchor)).map((a) => ({ agentId: a.agentId, basis: "related" }));
  return (e) => {
    if (e.actorType && INFRASTRUCTURE_ACTORS.has(e.actorType)) return [];
    const profile = hermesProfileOf(e);
    if (profile) {
      if (!ids.has(profile)) return [];
      const home = placed.find((a) => a.agentId === profile)?.path;
      return [{ agentId: profile, basis: "profile" }, ...(home ? above(home, new Set([profile])) : [])];
    }
    const cwd = e.cwd?.replace(/\/+$/, "");
    if (!cwd) return [];
    const containing = placed.filter((a) => under(a.path, cwd));
    if (!containing.length) return [];
    const deepest = Math.max(...containing.map((a) => a.path.length));
    // Several agents can share one repo (a PM and its scrum master). The PM or director owns the work;
    // the others only own it when no PM does, so a helper never pulses for work it was not handed.
    const here = containing.filter((a) => a.path.length === deepest);
    const lead = here.filter((a) => a.role === "pm" || a.role === "director");
    const owners = lead.length ? lead : here;
    return [
      ...owners.map((a): Owner => ({ agentId: a.agentId, basis: "project" })),
      ...containing.filter((a) => a.path.length < deepest).map((a): Owner => ({ agentId: a.agentId, basis: "related" }))
    ];
  };
}

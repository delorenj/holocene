/**
 * useAgentTickets — maps Plane active tickets to agent IDs.
 *
 * Returns a record of agentId → { ticketId, ticketTitle, ticketUrl, stateGroup }
 * for agents that have at least one "started" (in-progress) Plane issue assigned.
 *
 * Uses the same underlying Plane data as usePlaneWorkstreams but with
 * agent-specific filtering and state-aware matching.
 */

import { useQuery } from '@tanstack/react-query';
import { create33GODClient, type PlaneIssue } from '@services/plane';

// All Plane project IDs we monitor
const ACTIVE_PROJECT_IDS = [
  'cbfbb641-33e2-43c6-a7d1-ce63136ab689', // perth
  '10d06f8d-c110-4ce5-beaa-0914534b090a', // bloodbank
  'c5d51c41-eaf0-44ae-93ab-0a74712c3b86', // holocene
  '495de1b1-a4a2-4456-a185-351885858b1e', // imi
];

export type AgentTicket = {
  ticketId: string;
  ticketTitle: string;
  ticketUrl: string;
  stateGroup: string;    // started | unstarted | backlog | completed | cancelled
  priority: string;
  projectId: string;
};

export type AgentTicketMap = Record<string, AgentTicket>;

/**
 * Known mapping of Plane display_name → agent ID.
 * This is the canonical source of truth for "who owns what."
 * Keys are lowercased, stripped of non-alphanumeric chars.
 */
const ASSIGNEE_TO_AGENT: Record<string, string> = {
  'cack': 'cack',
  'grolf': 'grolf',
  'rererere': 'rererere',
  'lenoon': 'lenoon',
  'tonny': 'tonny',
  'tongy': 'tongy',
  'rar': 'rar',
  'pepe': 'pepe',
  'lalathing': 'lalathing',
  'momothecat': 'momothecat',
  'yi': 'yi',
  // Human aliases
  'jarad': 'grolf',
  'jaraddelorenzo': 'grolf',
  'delorenj': 'grolf',
};

function normalizeAssignee(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchAssigneeToAgent(displayName: string): string | null {
  const norm = normalizeAssignee(displayName);
  // Exact match first
  if (ASSIGNEE_TO_AGENT[norm]) return ASSIGNEE_TO_AGENT[norm];
  // Partial match
  for (const [key, agentId] of Object.entries(ASSIGNEE_TO_AGENT)) {
    if (norm.includes(key) || key.includes(norm)) return agentId;
  }
  return null;
}

function buildAgentTicketMap(issues: PlaneIssue[]): AgentTicketMap {
  const map: AgentTicketMap = {};

  // Only consider started (in-progress) issues — this is the RULE:
  // no "working" status unless there's a started ticket
  const startedIssues = issues.filter(
    (i) => i.state_detail?.group === 'started'
  );

  for (const issue of startedIssues) {
    const assignees = issue.assignee_details ?? [];
    for (const assignee of assignees) {
      const agentId = matchAssigneeToAgent(assignee.display_name);
      if (!agentId) continue;

      // First started ticket wins (highest priority)
      if (map[agentId]) continue;

      map[agentId] = {
        ticketId: `GOD-${issue.sequence_id}`,
        ticketTitle: issue.name,
        ticketUrl: `https://plane.delo.sh/33god/projects/${issue.project}/issues/${issue.id}`,
        stateGroup: issue.state_detail?.group ?? 'unknown',
        priority: issue.priority,
        projectId: issue.project,
      };
    }
  }

  return map;
}

export function useAgentTickets() {
  return useQuery({
    queryKey: ['plane', 'agent-tickets'],
    queryFn: async () => {
      const client = create33GODClient();
      const issues = await client.listAllActiveIssues(ACTIVE_PROJECT_IDS);
      return buildAgentTicketMap(issues);
    },
    staleTime: 1000 * 60 * 2, // 2 minutes
    refetchInterval: 1000 * 60 * 2, // auto-refetch every 2 min
    refetchOnWindowFocus: true,
  });
}

import { useQuery } from '@tanstack/react-query';
import { create33GODClient, type PlaneIssue } from '@services/plane';

// Project IDs from plane-workspaces.json
const ACTIVE_PROJECT_IDS = [
  'cbfbb641-33e2-43c6-a7d1-ce63136ab689', // perth (main board)
  '10d06f8d-c110-4ce5-beaa-0914534b090a', // bloodbank
  'c5d51c41-eaf0-44ae-93ab-0a74712c3b86', // holocene
  '495de1b1-a4a2-4456-a185-351885858b1e', // imi
];

export type StreamStatus = 'active' | 'blocked' | 'queued' | 'done';

export type PlaneLink = {
  workspace: string;
  project: string;
  issueIds: string[];
  url: string;
};

export type Workstream = {
  id: string;
  sequenceId: number;
  title: string;
  status: StreamStatus;
  lastActivityAt: string;
  needsResponse: boolean;
  responseReason?: string;
  unblockScore: number;
  moneyScore: number;
  activeOwners: string[];
  componentTags: string[];
  planeLinks: PlaneLink[];
  priority: string;
};

/**
 * Map Plane state group to Holocene StreamStatus
 */
function mapStateToStatus(stateGroup?: string): StreamStatus {
  switch (stateGroup) {
    case 'started':
      return 'active';
    case 'completed':
    case 'cancelled':
      return 'done';
    case 'backlog':
      return 'queued';
    case 'unstarted':
    default:
      return 'queued';
  }
}

/**
 * Derive unblock score from priority
 */
function priorityToUnblockScore(priority: string): number {
  switch (priority) {
    case 'urgent':
      return 95;
    case 'high':
      return 75;
    case 'medium':
      return 55;
    case 'low':
      return 30;
    default:
      return 40;
  }
}

/**
 * Check if issue needs response based on labels
 */
function checkNeedsResponse(labels: Array<{ name: string }>): {
  needsResponse: boolean;
  reason?: string;
} {
  const blockedLabel = labels.find(
    (l) =>
      l.name.toLowerCase().includes('blocked') ||
      l.name.toLowerCase().includes('waiting') ||
      l.name.toLowerCase().includes('needs-response')
  );

  if (blockedLabel) {
    return { needsResponse: true, reason: `Label: ${blockedLabel.name}` };
  }

  return { needsResponse: false };
}

/**
 * Convert Plane issue to Workstream
 */
function issueToWorkstream(issue: PlaneIssue): Workstream {
  const labels = issue.label_details ?? [];
  const assignees = issue.assignee_details ?? [];
  const { needsResponse, reason } = checkNeedsResponse(labels);

  return {
    id: issue.id,
    sequenceId: issue.sequence_id,
    title: issue.name,
    status: mapStateToStatus(issue.state_detail?.group),
    lastActivityAt: issue.updated_at,
    needsResponse,
    responseReason: reason,
    unblockScore: priorityToUnblockScore(issue.priority),
    moneyScore: 50, // Default; could derive from custom field or label later
    activeOwners: assignees.map((a) => a.display_name),
    componentTags: labels.map((l) => l.name),
    planeLinks: [
      {
        workspace: '33god',
        project: issue.project,
        issueIds: [`PERTH-${issue.sequence_id}`],
        url: `https://plane.delo.sh/33god/projects/${issue.project}/issues/${issue.id}`,
      },
    ],
    priority: issue.priority,
  };
}

export function usePlaneWorkstreams() {
  return useQuery({
    queryKey: ['plane', 'workstreams'],
    queryFn: async () => {
      const client = create33GODClient();
      const issues = await client.listAllActiveIssues(ACTIVE_PROJECT_IDS);
      return issues.map(issueToWorkstream);
    },
    staleTime: 1000 * 60 * 2, // 2 minutes
    refetchOnWindowFocus: true,
  });
}

/**
 * Plane API types (minimal subset for Holocene)
 */

export interface PlaneIssue {
  id: string;
  sequence_id: number;
  name: string;
  description_stripped?: string;
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  state_detail?: {
    id: string;
    name: string;
    group: string; // backlog | unstarted | started | completed | cancelled
    color: string;
  };
  label_details?: Array<{
    id: string;
    name: string;
    color: string;
  }>;
  assignee_details?: Array<{
    id: string;
    display_name: string;
    avatar?: string;
  }>;
  updated_at: string;
  created_at: string;
  project: string;
  workspace: string;
}

export interface PlaneProject {
  id: string;
  name: string;
  identifier: string;
  workspace: string;
}

export interface PlaneListResponse<T> {
  results: T[];
  total_count: number;
  next_page_results: boolean;
  prev_page_results: boolean;
}

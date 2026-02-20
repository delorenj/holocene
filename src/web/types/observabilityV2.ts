/**
 * Observability v2 Data Types
 * Auto-generated from OBSERVABILITY_V2_DATA_CONTRACT.md
 */

export interface Initiative {
  id: string;
  name: string;
  projectId: string;
  projectColor: string;
  
  // Metrics
  tokenSpend7d: number;
  tokenSpend30d: number;
  progressPercent: number;
  velocityScore: number;
  
  // Meta
  targetMilestone: 'sprint' | 'mvp' | 'launch';
  activeAgentIds: string[];
  lastActivityAt: string;
  
  // Anomaly detection
  isAnomaly: boolean;
  anomalyReason?: string;
}

export interface ProjectTokens {
  projectId: string;
  projectName: string;
  projectColor: string;
  tokenCount: number;
  percentage: number;
}

export interface DailySummary {
  date: string;
  actuals: ProjectTokens[];
  planned: ProjectTokens[];
  deltas: {
    projectId: string;
    delta: number;
    severity: 'ok' | 'warning' | 'critical';
  }[];
}

export interface InitiativePriority {
  initiativeId: string;
  initiativeName: string;
  priorityScore: number;
  upvotes: number;
  downvotes: number;
  lastUpvotedAt: string | null;
  lastUpvotedBy: string | null;
}

export interface TradeoffWarning {
  targetInitiativeId: string;
  targetInitiativeName: string;
  impacts: {
    initiativeId: string;
    initiativeName: string;
    tokenDelta: number;
    progressDelta: number;
    delayDays: number;
  }[];
  riskLevel: 'low' | 'medium' | 'high';
  riskReason: string;
}

// API Response Types
export interface GetInitiativesResponse {
  initiatives: Initiative[];
}

export interface GetDailySummaryResponse extends DailySummary {}

export interface GetPrioritiesResponse {
  priorities: InitiativePriority[];
}

export interface UpvoteResponse {
  requiresConfirmation: boolean;
  tradeoffWarning?: TradeoffWarning;
}

export interface ConfirmUpvoteResponse {
  success: boolean;
  newPriority: InitiativePriority;
}

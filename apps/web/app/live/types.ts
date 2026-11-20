// The shape GET /api/modules/live/apps answers with (apps/api/src/live.ts). Kept as a copy, like the other tabs.

export type SourceStatus = "ok" | "warn" | "down" | "unavailable" | "pending";

export type LiveSource<T> = {
  status: SourceStatus;
  checkedAt?: string;
  ageSeconds?: number;
  maxSeconds: number;
  detail?: string;
  data?: T;
};

export type ReleaseView = {
  version: string;
  code: number;
  sha256: string;
  url: string;
  bytes?: number;
  package?: string;
  updatedAt?: string;
  commit?: string;
  apk: { status?: number; reachable: boolean; sizeMatches: boolean | null; contentLength?: number };
  packageMatches: boolean | null;
};
export type StorefrontView = { status: number; hasBuyButton: boolean; checkoutUrl?: string; apkLinks: string[]; apkMatchesRelease: boolean | null };
export type SalesView = {
  count: number;
  gross: Record<string, number>;
  currency?: string;
  grossMinor: number;
  firstSaleAt?: string;
  lastSaleAt?: string;
  refunds: { count: number; amountMinor: number };
  disputes: { count: number };
  truncated: boolean;
};
export type FulfilmentView = {
  due: number;
  overdue: number;
  clear: number;
  blocked: number;
  other: number;
  soonestDueAt?: string;
  worstOverdueSeconds?: number;
  blockedReasons: string[];
  promiseHours?: number;
  urgency: "overdue" | "owed" | "clear" | "unknown";
};
export type ReminderView = {
  name: string;
  enabled: boolean;
  schedule: string;
  lastRun?: { result: "success" | "fail" | "running"; startedAt: string; finishedAt?: string } | null;
};
export type ActivityView = { recent: Array<{ key: string; title: string; state?: string; updatedAt: string }> };

export type LiveApp = {
  id: string;
  name: string;
  tagline: string;
  platform: string;
  package: string;
  offer?: string;
  board: string;
  epic?: string;
  support?: string;
  declared?: string;
  liveSince: string;
  daysLive: number;
  firstPromoted: boolean;
  storeUrl: string;
  links: {
    store: string;
    checkout?: string;
    board?: string;
    release: string;
    apk?: string;
    candybar?: string;
    evidence: Array<{ label: string; href: string }>;
  };
  sources: {
    release: LiveSource<ReleaseView>;
    storefront: LiveSource<StorefrontView>;
    sales: LiveSource<SalesView>;
    fulfilment: LiveSource<FulfilmentView>;
    reminder: LiveSource<ReminderView>;
    activity: LiveSource<ActivityView>;
  };
};

export type LivePayload = {
  generatedAt: string;
  today: string;
  source: { name: string; down?: boolean; detail?: string };
  apps: LiveApp[];
  skipped: Array<{ id: string; name: string; problems: string[] }>;
};

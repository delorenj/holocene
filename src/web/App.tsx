import React, { useMemo, useState } from 'react';

type StreamStatus = 'active' | 'blocked' | 'queued' | 'done';

type PlaneLink = {
  workspace: string;
  project: string;
  issueIds: string[];
  url: string;
};

type Workstream = {
  id: string;
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
};

type RankedWorkstream = Workstream & {
  recencyBoost: number;
  priorityScore: number;
};

const MOCK_STREAMS: Workstream[] = [
  {
    id: 'ws-team-infra-dispatch',
    title: 'Team Infra Auto-Dispatch',
    status: 'active',
    lastActivityAt: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
    needsResponse: true,
    responseReason: 'Approve M2.5 Plane writeback behavior',
    unblockScore: 82,
    moneyScore: 55,
    activeOwners: ['Cack', 'bloodbank', 'candybar'],
    componentTags: ['bloodbank', 'candybar', 'plane'],
    planeLinks: [
      {
        workspace: '33god',
        project: 'board',
        issueIds: ['PERTH-9003'],
        url: 'https://plane.delo.sh',
      },
    ],
  },
  {
    id: 'ws-curi-deploy',
    title: 'Curi Secure OpenClaw Delivery',
    status: 'active',
    lastActivityAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    needsResponse: true,
    responseReason: 'Telegram pairing verification from Pete',
    unblockScore: 60,
    moneyScore: 92,
    activeOwners: ['Jarad', 'Cack'],
    componentTags: ['deployment', 'security', 'telegram'],
    planeLinks: [
      {
        workspace: 'curi',
        project: 'ops',
        issueIds: ['CURI-1'],
        url: 'https://plane.delo.sh',
      },
    ],
  },
  {
    id: 'ws-agentic-ux',
    title: 'Agentic UX + Holocene MVP',
    status: 'queued',
    lastActivityAt: new Date(Date.now() - 1000 * 60 * 75).toISOString(),
    needsResponse: false,
    unblockScore: 70,
    moneyScore: 88,
    activeOwners: ['Jarad'],
    componentTags: ['holocene', 'ux', 'mobile-first'],
    planeLinks: [
      {
        workspace: '33god',
        project: 'holocene',
        issueIds: ['HLC-1'],
        url: 'https://plane.delo.sh',
      },
    ],
  },
  {
    id: 'ws-intelliforia-patches',
    title: 'Intelliforia Stability Patches',
    status: 'blocked',
    lastActivityAt: new Date(Date.now() - 1000 * 60 * 180).toISOString(),
    needsResponse: true,
    responseReason: 'Need scope call before touching additional pages',
    unblockScore: 66,
    moneyScore: 73,
    activeOwners: ['Jarad'],
    componentTags: ['rethink', 'extension'],
    planeLinks: [
      {
        workspace: 'intelliforia',
        project: 'chrome-extension',
        issueIds: ['CWS-015'],
        url: 'https://plane.internal.intelliforia.com',
      },
    ],
  },
  {
    id: 'ws-memory-hardening',
    title: 'LanceDB Memory Hardening',
    status: 'done',
    lastActivityAt: new Date(Date.now() - 1000 * 60 * 400).toISOString(),
    needsResponse: false,
    unblockScore: 40,
    moneyScore: 35,
    activeOwners: ['Cack'],
    componentTags: ['openclaw', 'memory'],
    planeLinks: [
      {
        workspace: '33god',
        project: 'board',
        issueIds: ['PERTH-14'],
        url: 'https://plane.delo.sh',
      },
    ],
  },
];

const statusStyle: Record<StreamStatus, string> = {
  active: 'bg-emerald-100 text-emerald-700',
  blocked: 'bg-rose-100 text-rose-700',
  queued: 'bg-amber-100 text-amber-700',
  done: 'bg-slate-100 text-slate-700',
};

const ownerLightStyle: Record<StreamStatus, string> = {
  active: 'bg-emerald-500',
  blocked: 'bg-rose-500',
  queued: 'bg-amber-500',
  done: 'bg-slate-400',
};

const getHoursAgo = (isoDate: string): number => {
  const deltaMs = Date.now() - new Date(isoDate).getTime();
  return Math.max(0, Math.floor(deltaMs / (1000 * 60 * 60)));
};

const computeRanked = (streams: Workstream[]): RankedWorkstream[] => {
  const maxHours = 72;
  return streams
    .map((stream) => {
      const hoursAgo = getHoursAgo(stream.lastActivityAt);
      const recencyBoost = Math.max(0, Math.round(20 * (1 - Math.min(hoursAgo, maxHours) / maxHours)));
      const priorityScore =
        (stream.needsResponse ? 40 : 0) +
        stream.unblockScore * 0.35 +
        stream.moneyScore * 0.25 +
        recencyBoost;

      return {
        ...stream,
        recencyBoost,
        priorityScore: Math.round(priorityScore),
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore);
};

const StreamCard: React.FC<{
  stream: RankedWorkstream;
  onOpen: (stream: RankedWorkstream) => void;
}> = ({ stream, onOpen }) => {
  const hoursAgo = getHoursAgo(stream.lastActivityAt);

  return (
    <button
      onClick={() => onOpen(stream)}
      className="w-full text-left rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md"
      type="button"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900">{stream.title}</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyle[stream.status]}`}>
          {stream.status}
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span>⏱ {hoursAgo}h ago</span>
        <span>•</span>
        <span>Priority {stream.priorityScore}</span>
        <span>•</span>
        <span>Unblock {stream.unblockScore}</span>
        <span>•</span>
        <span>Money {stream.moneyScore}</span>
      </div>

      <div className="mb-3 flex flex-wrap gap-1">
        {stream.componentTags.map((tag) => (
          <span key={tag} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
            {tag}
          </span>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <div className="flex -space-x-1">
          {stream.activeOwners.map((owner) => (
            <span
              key={owner}
              title={owner}
              className={`inline-block h-3 w-3 rounded-full ring-2 ring-white ${ownerLightStyle[stream.status]}`}
            />
          ))}
        </div>
        {stream.needsResponse ? (
          <span className="rounded-md bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700">Needs response</span>
        ) : (
          <span className="text-xs text-slate-400">No blocker ping</span>
        )}
      </div>
    </button>
  );
};

const MobileScreen: React.FC<{
  title: string;
  subtitle: string;
  children: React.ReactNode;
}> = ({ title, subtitle, children }) => {
  return (
    <section className="w-full shrink-0 snap-start px-4 pb-6 md:min-w-0 md:px-0">
      <div className="mb-3">
        <h2 className="text-lg font-bold text-slate-900">{title}</h2>
        <p className="text-sm text-slate-500">{subtitle}</p>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
};

export const App: React.FC = () => {
  const [selected, setSelected] = useState<RankedWorkstream | null>(null);
  const [backlogInput, setBacklogInput] = useState('');
  const [backlogItems, setBacklogItems] = useState<string[]>([
    'Define stream-to-ticket mapping rules',
    'Draft default response-needed heuristics',
  ]);

  const ranked = useMemo(() => computeRanked(MOCK_STREAMS), []);
  const needsResponse = useMemo(() => ranked.filter((stream) => stream.needsResponse), [ranked]);
  const impactRanked = useMemo(
    () => [...ranked].sort((a, b) => b.unblockScore + b.moneyScore - (a.unblockScore + a.moneyScore)),
    [ranked],
  );

  const handleAddBacklog = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = backlogInput.trim();
    if (!trimmed) {
      return;
    }
    setBacklogItems((prev) => [trimmed, ...prev]);
    setBacklogInput('');
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur md:px-6">
        <h1 className="text-xl font-bold">Holocene Control Tower</h1>
        <p className="text-xs text-slate-500">
          Plane is system-of-record. Holocene is system-of-focus. Swipe on mobile, dashboard on web.
        </p>
      </header>

      <main className="mx-auto max-w-7xl py-4 md:px-6">
        <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4 md:grid md:grid-cols-2 md:overflow-visible lg:grid-cols-4">
          <MobileScreen
            title="Now"
            subtitle="Ranked by response urgency + unblock + money + recency"
          >
            {ranked.map((stream) => (
              <StreamCard key={stream.id} stream={stream} onOpen={setSelected} />
            ))}
          </MobileScreen>

          <MobileScreen title="Needs Response" subtitle="Things waiting on you right now">
            {needsResponse.length > 0 ? (
              needsResponse.map((stream) => <StreamCard key={stream.id} stream={stream} onOpen={setSelected} />)
            ) : (
              <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">No response-needed items 🎉</div>
            )}
          </MobileScreen>

          <MobileScreen title="Impact" subtitle="Weighted by unblock + monetary potential">
            {impactRanked.map((stream) => (
              <StreamCard key={stream.id} stream={stream} onOpen={setSelected} />
            ))}
          </MobileScreen>

          <MobileScreen title="Backlog Capture" subtitle="Fast input for uncategorized ideas/tasks">
            <form onSubmit={handleAddBacklog} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <label htmlFor="capture" className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Add item
              </label>
              <textarea
                id="capture"
                value={backlogInput}
                onChange={(event) => setBacklogInput(event.target.value)}
                placeholder="Drop an idea, blocker, or follow-up..."
                className="h-24 w-full rounded-lg border border-slate-200 p-2 text-sm outline-none focus:border-slate-400"
              />
              <button
                type="submit"
                className="mt-3 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
              >
                Capture
              </button>
            </form>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="mb-2 text-sm font-semibold">Queued for triage</h3>
              <ul className="space-y-2 text-sm text-slate-700">
                {backlogItems.map((item) => (
                  <li key={item} className="rounded-lg bg-slate-50 px-2 py-1">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </MobileScreen>
        </div>
      </main>

      {selected ? (
        <div className="fixed inset-0 z-20 flex items-end bg-slate-900/40 md:items-center md:justify-center" role="dialog" aria-modal="true">
          <div className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 md:max-w-2xl md:rounded-2xl">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold">{selected.title}</h3>
                <p className="text-xs text-slate-500">Workstream drilldown shell (M0)</p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-lg border border-slate-200 px-2 py-1 text-sm hover:bg-slate-50"
              >
                Close
              </button>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-slate-200 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Status</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{selected.status}</p>
              </div>
              <div className="rounded-xl border border-slate-200 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Priority Score</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{selected.priorityScore}</p>
              </div>
              <div className="rounded-xl border border-slate-200 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Needs Response</p>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {selected.needsResponse ? selected.responseReason ?? 'Yes' : 'No'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Active Owners</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{selected.activeOwners.join(', ')}</p>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-slate-200 p-3">
              <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">Plane Links</p>
              <ul className="space-y-2 text-sm">
                {selected.planeLinks.map((link) => (
                  <li key={`${link.workspace}-${link.project}-${link.issueIds.join('-')}`}>
                    <a href={link.url} target="_blank" rel="noreferrer" className="font-medium text-blue-600 hover:underline">
                      {link.workspace}/{link.project}
                    </a>
                    <span className="ml-2 text-slate-500">{link.issueIds.join(', ')}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

import React, { useMemo, useState } from 'react';
import { usePlaneWorkstreams, type Workstream, type StreamStatus } from './hooks/usePlaneWorkstreams';
import { AgentGraph } from './components/agent-graph';

type RankedWorkstream = Workstream & {
  recencyBoost: number;
  priorityScore: number;
};

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
          {stream.activeOwners.length > 0 ? (
            stream.activeOwners.map((owner) => (
              <span
                key={owner}
                title={owner}
                className={`inline-block h-3 w-3 rounded-full ring-2 ring-white ${ownerLightStyle[stream.status]}`}
              />
            ))
          ) : (
            <span className="text-xs text-slate-400">Unassigned</span>
          )}
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

const LoadingCard: React.FC = () => (
  <div className="animate-pulse rounded-2xl border border-slate-200 bg-white p-4">
    <div className="mb-3 h-4 w-3/4 rounded bg-slate-200" />
    <div className="mb-2 h-3 w-1/2 rounded bg-slate-100" />
    <div className="h-3 w-1/3 rounded bg-slate-100" />
  </div>
);

const ErrorCard: React.FC<{ message: string }> = ({ message }) => (
  <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
    <p className="font-semibold">Failed to load tickets</p>
    <p className="mt-1 text-xs">{message}</p>
  </div>
);

type TabId = 'workstreams' | 'agent-graph';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId>('workstreams');
  const [selected, setSelected] = useState<RankedWorkstream | null>(null);
  const [backlogInput, setBacklogInput] = useState('');
  const [backlogItems, setBacklogItems] = useState<string[]>([
    'Define stream-to-ticket mapping rules',
    'Draft default response-needed heuristics',
  ]);

  const { data: workstreams, isLoading, error } = usePlaneWorkstreams();

  const ranked = useMemo(() => computeRanked(workstreams ?? []), [workstreams]);
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

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'workstreams', label: 'Workstreams', icon: '📋' },
    { id: 'agent-graph', label: 'Agent Graph', icon: '🔮' },
  ];

  // Agent Graph tab is full-screen dark
  if (activeTab === 'agent-graph') {
    return (
      <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
        <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-slate-800 bg-slate-950/95 px-4 py-2 backdrop-blur">
          <h1 className="text-lg font-bold text-slate-200">Holocene</h1>
          <nav className="flex gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-500 hover:bg-slate-800/50 hover:text-slate-300'
                }`}
              >
                {tab.icon} {tab.label}
              </button>
            ))}
          </nav>
        </header>
        <div className="flex-1 overflow-hidden">
          <AgentGraph />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur md:px-6">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold">Holocene Control Tower</h1>
          <nav className="flex gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                }`}
              >
                {tab.icon} {tab.label}
              </button>
            ))}
          </nav>
        </div>
        <p className="text-xs text-slate-500">
          Plane is system-of-record. Holocene is system-of-focus. Swipe on mobile, dashboard on web.
          {workstreams && <span className="ml-2 text-emerald-600">● {workstreams.length} tickets loaded</span>}
        </p>
      </header>

      <main className="mx-auto max-w-7xl py-4 md:px-6">
        <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4 md:grid md:grid-cols-2 md:overflow-visible lg:grid-cols-4">
          <MobileScreen
            title="Now"
            subtitle="Ranked by response urgency + unblock + money + recency"
          >
            {isLoading ? (
              <>
                <LoadingCard />
                <LoadingCard />
                <LoadingCard />
              </>
            ) : error ? (
              <ErrorCard message={error instanceof Error ? error.message : 'Unknown error'} />
            ) : ranked.length > 0 ? (
              ranked.map((stream) => (
                <StreamCard key={stream.id} stream={stream} onOpen={setSelected} />
              ))
            ) : (
              <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
                No tickets found
              </div>
            )}
          </MobileScreen>

          <MobileScreen title="Needs Response" subtitle="Things waiting on you right now">
            {isLoading ? (
              <LoadingCard />
            ) : needsResponse.length > 0 ? (
              needsResponse.map((stream) => <StreamCard key={stream.id} stream={stream} onOpen={setSelected} />)
            ) : (
              <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">No response-needed items 🎉</div>
            )}
          </MobileScreen>

          <MobileScreen title="Impact" subtitle="Weighted by unblock + monetary potential">
            {isLoading ? (
              <>
                <LoadingCard />
                <LoadingCard />
              </>
            ) : (
              impactRanked.map((stream) => (
                <StreamCard key={stream.id} stream={stream} onOpen={setSelected} />
              ))
            )}
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
                <p className="text-xs text-slate-500">PERTH-{selected.sequenceId} • Priority: {selected.priority}</p>
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
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {selected.activeOwners.length > 0 ? selected.activeOwners.join(', ') : 'Unassigned'}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-slate-200 p-3">
              <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">Plane Link</p>
              <ul className="space-y-2 text-sm">
                {selected.planeLinks.map((link) => (
                  <li key={`${link.workspace}-${link.project}-${link.issueIds.join('-')}`}>
                    <a href={link.url} target="_blank" rel="noreferrer" className="font-medium text-blue-600 hover:underline">
                      Open in Plane →
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

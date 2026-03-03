import React, { useState } from 'react';
import { AgentGraph } from './components/agent-graph';
import { EventsPanel } from './components/events';
import { ProjectsView } from './components/projects';
import { CommandDashboard } from './components/command-dashboard';
import { BloodbankTestBoard } from './components/test-board';

type TabId = 'projects' | 'agent-graph' | 'events' | 'commands' | 'test-board';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'projects',    label: 'Projects',     icon: '🎯' },
  { id: 'agent-graph', label: 'Agents',       icon: '🔮' },
  { id: 'events',      label: 'Events',       icon: '⚡' },
  { id: 'commands',    label: 'Commands',     icon: '🦎' },
  { id: 'test-board',  label: 'Test Board',   icon: '🧪' },
];

// ---------------------------------------------------------------------------
// Shared dark-mode shell for all tabs
// ---------------------------------------------------------------------------
const DarkShell: React.FC<{
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  children: React.ReactNode;
}> = ({ activeTab, setActiveTab, children }) => (
  <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
    <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-slate-800 bg-slate-950/95 px-4 py-2 backdrop-blur">
      <h1 className="text-lg font-bold text-slate-200">Holocene</h1>
      <nav className="flex gap-1">
        {TABS.map((tab) => (
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
    <div className="flex-1 overflow-hidden">{children}</div>
  </div>
);

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId>('projects');

  return (
    <DarkShell activeTab={activeTab} setActiveTab={setActiveTab}>
      {activeTab === 'projects' && <ProjectsView />}
      {activeTab === 'agent-graph' && <AgentGraph />}
      {activeTab === 'events' && <EventsPanel />}
      {activeTab === 'commands' && <CommandDashboard />}
      {activeTab === 'test-board' && <BloodbankTestBoard />}
    </DarkShell>
  );
};

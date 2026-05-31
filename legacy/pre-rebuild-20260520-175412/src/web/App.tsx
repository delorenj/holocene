import React from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { AgentGraph } from './components/agent-graph';
import { EventsPanel } from './components/events';
import { ProjectsView } from './components/projects';
import { CommandDashboard } from './components/command-dashboard';
import { BloodbankTestBoard } from './components/test-board';
import { ServicesView } from './components/services';

const TABS = [
  { path: '/projects',    label: 'Projects',   icon: '🎯' },
  { path: '/agents',      label: 'Agents',     icon: '🔮' },
  { path: '/events',      label: 'Events',     icon: '⚡' },
  { path: '/commands',    label: 'Commands',   icon: '🦎' },
  { path: '/test-board',  label: 'Test Board', icon: '🧪' },
  { path: '/services',    label: 'Services',   icon: '⚙️' },
];

// ---------------------------------------------------------------------------
// Shared dark-mode shell for all tabs
// ---------------------------------------------------------------------------
const DarkShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
    <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-slate-800 bg-slate-950/95 px-4 py-2 backdrop-blur">
      <h1 className="text-lg font-bold text-slate-200">Holocene</h1>
      <nav className="flex gap-1">
        {TABS.map((tab) => (
          <NavLink
            key={tab.path}
            to={tab.path}
            className={({ isActive }) =>
              `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-500 hover:bg-slate-800/50 hover:text-slate-300'
              }`
            }
          >
            {tab.icon} {tab.label}
          </NavLink>
        ))}
      </nav>
    </header>
    <div className="flex-1 overflow-hidden">{children}</div>
  </div>
);

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export const App: React.FC = () => (
  <DarkShell>
    <Routes>
      <Route path="/projects" element={<ProjectsView />} />
      <Route path="/agents" element={<AgentGraph />} />
      <Route path="/events" element={<EventsPanel />} />
      <Route path="/commands" element={<CommandDashboard />} />
      <Route path="/test-board" element={<BloodbankTestBoard />} />
      <Route path="/services/*" element={<ServicesView />} />
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  </DarkShell>
);

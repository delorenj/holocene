/**
 * CommandDashboard — Holocene tab for command system observability (OBS-1/GOD-5).
 *
 * Shows:
 *  - Live command lifecycle feed (envelope → ack → result/error)
 *  - Per-agent conformance cards (ack rate, latency, success rate)
 *  - FSM state heatmap
 *  - Error breakdown
 */
import React, { useState, useMemo } from 'react';
import { useCommandStream, type CommandRecord, type CommandPhase } from '../../hooks/useCommandStream';
import { AgentConformanceCard } from './AgentConformanceCard';
import { CommandTimeline } from './CommandTimeline';
import { GlobalMetrics } from './GlobalMetrics';

// ---------------------------------------------------------------------------
// Phase badge colors
// ---------------------------------------------------------------------------
export const PHASE_COLORS: Record<CommandPhase, { bg: string; text: string; dot: string }> = {
  dispatched: { bg: 'bg-blue-900/40', text: 'text-blue-300', dot: 'bg-blue-400' },
  acked:      { bg: 'bg-yellow-900/40', text: 'text-yellow-300', dot: 'bg-yellow-400' },
  working:    { bg: 'bg-amber-900/40', text: 'text-amber-300', dot: 'bg-amber-400' },
  completed:  { bg: 'bg-emerald-900/40', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  failed:     { bg: 'bg-red-900/40', text: 'text-red-300', dot: 'bg-red-400' },
  expired:    { bg: 'bg-slate-800', text: 'text-slate-400', dot: 'bg-slate-500' },
};

export function PhaseBadge({ phase }: { phase: CommandPhase }) {
  const c = PHASE_COLORS[phase];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${c.bg} ${c.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {phase}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------
type ViewMode = 'overview' | 'timeline';

export const CommandDashboard: React.FC = () => {
  const { commands, agentStats, connected, historyLoading, totalCommands } = useCommandStream();
  const [viewMode, setViewMode] = useState<ViewMode>('overview');
  const [agentFilter, setAgentFilter] = useState<string | null>(null);

  const filteredCommands = useMemo(() => {
    if (!agentFilter) return commands;
    return commands.filter(c => c.targetAgent === agentFilter);
  }, [commands, agentFilter]);

  // Sort by most recent first
  const sortedCommands = useMemo(() => {
    return [...filteredCommands].sort((a, b) => {
      const tA = a.completedAt ?? a.ackedAt ?? a.dispatchedAt;
      const tB = b.completedAt ?? b.ackedAt ?? b.dispatchedAt;
      return tB.localeCompare(tA);
    });
  }, [filteredCommands]);

  const agents = useMemo(() => agentStats.map(s => s.agent), [agentStats]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-950 text-slate-100">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div>
          <h2 className="text-xl font-bold">Command Conformance ⚡</h2>
          <p className="text-sm text-slate-400">
            {connected ? '🟢 Live' : '🔴 Disconnected'}
            {' · '}
            {totalCommands} commands tracked
            {historyLoading && ' · Loading history…'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Agent filter */}
          <select
            value={agentFilter ?? ''}
            onChange={(e) => setAgentFilter(e.target.value || null)}
            className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-300"
          >
            <option value="">All Agents</option>
            {agents.map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>

          {/* View toggle */}
          <div className="flex rounded-lg border border-slate-700">
            <button
              type="button"
              onClick={() => setViewMode('overview')}
              className={`rounded-l-lg px-3 py-1 text-sm ${
                viewMode === 'overview'
                  ? 'bg-slate-700 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Overview
            </button>
            <button
              type="button"
              onClick={() => setViewMode('timeline')}
              className={`rounded-r-lg px-3 py-1 text-sm ${
                viewMode === 'timeline'
                  ? 'bg-slate-700 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Timeline
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {totalCommands === 0 && !historyLoading ? (
          <EmptyState />
        ) : viewMode === 'overview' ? (
          <>
            <GlobalMetrics agentStats={agentStats} commands={commands} />
            <div className="mt-6">
              <h3 className="mb-3 text-lg font-semibold text-slate-200">Per-Agent Conformance</h3>
              {agentStats.length === 0 ? (
                <p className="text-sm text-slate-500">No agent data yet.</p>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {agentStats
                    .filter(s => !agentFilter || s.agent === agentFilter)
                    .map(stats => (
                      <AgentConformanceCard
                        key={stats.agent}
                        stats={stats}
                        onSelect={() => setAgentFilter(
                          agentFilter === stats.agent ? null : stats.agent
                        )}
                        selected={agentFilter === stats.agent}
                      />
                    ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <CommandTimeline commands={sortedCommands} />
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
const EmptyState: React.FC = () => (
  <div className="flex h-full flex-col items-center justify-center text-slate-500">
    <div className="text-6xl">🦎</div>
    <h3 className="mt-4 text-lg font-semibold text-slate-400">
      No Commands Yet
    </h3>
    <p className="mt-1 max-w-md text-center text-sm">
      When agents start receiving commands via{' '}
      <code className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-emerald-400">
        command.{'{'} agent {'}'}.{'{'} action {'}'}
      </code>{' '}
      routing keys, they'll appear here with full lifecycle tracking.
    </p>
    <div className="mt-6 rounded-lg border border-dashed border-slate-700 p-4 text-left text-xs">
      <p className="text-slate-400">Expected routing key patterns:</p>
      <pre className="mt-1 text-slate-500">
{`command.lenoon.run_drift_check         → envelope
command.lenoon.run_drift_check.ack     → acknowledged
command.lenoon.run_drift_check.result  → completed
command.lenoon.run_drift_check.error   → failed

command.cack.run_git_maintenance       → envelope
command.cack.run_git_maintenance.ack   → acknowledged
command.cack.run_git_maintenance.result → completed
command.cack.run_git_maintenance.error  → failed`}
      </pre>
    </div>
  </div>
);

/**
 * CommandTimeline — Chronological view of individual command lifecycles.
 *
 * Each row shows: agent, action, phase badge, latency, outcome.
 * Expandable rows for full payload details.
 */
import React, { useState } from 'react';
import type { CommandRecord } from '../../hooks/useCommandStream';
import { PhaseBadge } from './CommandDashboard';

type Props = {
  commands: CommandRecord[];
};

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function priorityBadge(priority: string) {
  const styles: Record<string, string> = {
    critical: 'bg-red-900/50 text-red-300 ring-1 ring-red-700',
    high: 'bg-orange-900/40 text-orange-300',
    normal: 'bg-slate-800 text-slate-400',
    low: 'bg-slate-800/50 text-slate-500',
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${styles[priority] ?? styles.normal}`}>
      {priority}
    </span>
  );
}

const CommandRow: React.FC<{ cmd: CommandRecord }> = ({ cmd }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-slate-800/50">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-900/50"
      >
        {/* Timestamp */}
        <span className="w-20 shrink-0 font-mono text-xs text-slate-500">
          {formatTimestamp(cmd.dispatchedAt)}
        </span>

        {/* Agent */}
        <span className="w-24 shrink-0 truncate font-medium text-slate-200">
          {cmd.targetAgent}
        </span>

        {/* Action */}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-400">
          {cmd.action}
        </span>

        {/* Priority */}
        {priorityBadge(cmd.priority)}

        {/* Phase */}
        <PhaseBadge phase={cmd.phase} />

        {/* Ack latency */}
        <span className="w-16 shrink-0 text-right font-mono text-xs text-slate-500">
          {cmd.ackLatencyMs != null ? formatMs(cmd.ackLatencyMs) : '—'}
        </span>

        {/* Total duration */}
        <span className="w-16 shrink-0 text-right font-mono text-xs text-slate-500">
          {cmd.totalDurationMs != null ? formatMs(cmd.totalDurationMs) : '—'}
        </span>

        {/* Expand icon */}
        <span className="w-5 text-center text-slate-600">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div className="bg-slate-900/30 px-6 py-3 text-xs">
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 md:grid-cols-4">
            <div>
              <span className="text-slate-500">Command ID:</span>
              <span className="ml-1 font-mono text-slate-300">{cmd.commandId.slice(0, 8)}…</span>
            </div>
            <div>
              <span className="text-slate-500">Issued by:</span>
              <span className="ml-1 text-slate-300">{cmd.issuedBy}</span>
            </div>
            <div>
              <span className="text-slate-500">TTL:</span>
              <span className="ml-1 text-slate-300">{formatMs(cmd.ttlMs)}</span>
            </div>
            <div>
              <span className="text-slate-500">FSM Version:</span>
              <span className="ml-1 text-slate-300">{cmd.fsmVersion ?? '—'}</span>
            </div>
            {cmd.idempotencyKey && (
              <div>
                <span className="text-slate-500">Idemp Key:</span>
                <span className="ml-1 font-mono text-slate-300">{cmd.idempotencyKey}</span>
              </div>
            )}
            {cmd.outcome && (
              <div>
                <span className="text-slate-500">Outcome:</span>
                <span className={`ml-1 font-medium ${
                  cmd.outcome === 'success' ? 'text-emerald-400' :
                  cmd.outcome === 'partial' ? 'text-yellow-400' :
                  'text-slate-400'
                }`}>{cmd.outcome}</span>
              </div>
            )}
            {cmd.errorCode && (
              <div className="col-span-2">
                <span className="text-red-400">Error:</span>
                <span className="ml-1 text-red-300">
                  [{cmd.errorCode}] {cmd.errorMessage}
                  {cmd.retryable && <span className="ml-2 text-yellow-400">(retryable)</span>}
                </span>
              </div>
            )}
          </div>

          {/* Lifecycle timeline */}
          <div className="mt-3 flex items-center gap-2 text-[10px]">
            <span className="text-blue-400">dispatched</span>
            {cmd.ackedAt && (
              <>
                <span className="text-slate-600">→</span>
                <span className="text-yellow-400">
                  acked ({formatMs(cmd.ackLatencyMs)})
                </span>
              </>
            )}
            {cmd.completedAt && (
              <>
                <span className="text-slate-600">→</span>
                <span className={cmd.phase === 'completed' ? 'text-emerald-400' : 'text-red-400'}>
                  {cmd.phase} ({formatMs(cmd.totalDurationMs)})
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export const CommandTimeline: React.FC<Props> = ({ commands }) => {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/30">
      {/* Header row */}
      <div className="flex items-center gap-3 border-b border-slate-700 px-3 py-2 text-xs font-medium uppercase tracking-wider text-slate-500">
        <span className="w-20 shrink-0">Time</span>
        <span className="w-24 shrink-0">Agent</span>
        <span className="min-w-0 flex-1">Action</span>
        <span className="w-12">Pri</span>
        <span className="w-24">Phase</span>
        <span className="w-16 text-right">Ack</span>
        <span className="w-16 text-right">Total</span>
        <span className="w-5" />
      </div>

      {/* Rows */}
      <div className="max-h-[calc(100vh-16rem)] overflow-y-auto">
        {commands.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-slate-500">
            No commands match current filter.
          </div>
        ) : (
          commands.slice(0, 200).map(cmd => (
            <CommandRow key={cmd.commandId} cmd={cmd} />
          ))
        )}
      </div>
    </div>
  );
};

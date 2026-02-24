/**
 * AgentConformanceCard — Per-agent command conformance summary.
 *
 * Shows ack rate, success rate, latency, error codes, and last activity.
 */
import React from 'react';
import type { AgentCommandStats } from '../../hooks/useCommandStream';

type Props = {
  stats: AgentCommandStats;
  onSelect: () => void;
  selected: boolean;
};

function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRate(rate: number | null): string {
  if (rate == null) return '—';
  return `${Math.round(rate * 100)}%`;
}

function rateColor(rate: number | null, good: number): string {
  if (rate == null) return 'text-slate-400';
  return rate >= good ? 'text-emerald-400' : rate >= good * 0.8 ? 'text-yellow-400' : 'text-red-400';
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export const AgentConformanceCard: React.FC<Props> = ({ stats, onSelect, selected }) => {
  const { agent, total, acked, completed, failed, pending, avgAckLatencyMs, avgDurationMs, successRate, errorCodes, lastCommandAt } = stats;
  const ackRate = total > 0 ? acked / total : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border p-4 text-left transition-colors ${
        selected
          ? 'border-blue-600 bg-blue-950/30'
          : 'border-slate-800 bg-slate-900/50 hover:border-slate-600'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold text-slate-100">{agent}</span>
          {pending > 0 && (
            <span className="rounded-full bg-yellow-900/40 px-1.5 py-0.5 text-xs text-yellow-400">
              {pending} pending
            </span>
          )}
        </div>
        <span className="text-xs text-slate-500">{timeAgo(lastCommandAt)}</span>
      </div>

      {/* Stats grid */}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <span className="text-xs text-slate-500">Total</span>
          <p className="font-semibold text-slate-200">{total}</p>
        </div>
        <div>
          <span className="text-xs text-slate-500">Ack Rate</span>
          <p className={`font-semibold ${rateColor(ackRate, 0.95)}`}>
            {formatRate(ackRate)}
          </p>
        </div>
        <div>
          <span className="text-xs text-slate-500">Success Rate</span>
          <p className={`font-semibold ${rateColor(successRate, 0.9)}`}>
            {formatRate(successRate)}
          </p>
        </div>
        <div>
          <span className="text-xs text-slate-500">Avg Ack</span>
          <p className={`font-semibold ${
            avgAckLatencyMs != null && avgAckLatencyMs < 1000
              ? 'text-emerald-400'
              : avgAckLatencyMs != null && avgAckLatencyMs < 5000
                ? 'text-yellow-400'
                : 'text-slate-300'
          }`}>
            {formatMs(avgAckLatencyMs)}
          </p>
        </div>
        <div>
          <span className="text-xs text-slate-500">Avg Duration</span>
          <p className="font-semibold text-slate-300">{formatMs(avgDurationMs)}</p>
        </div>
        <div>
          <span className="text-xs text-slate-500">Failed</span>
          <p className={`font-semibold ${failed > 0 ? 'text-red-400' : 'text-slate-400'}`}>
            {failed}
          </p>
        </div>
      </div>

      {/* Error codes */}
      {Object.keys(errorCodes).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {Object.entries(errorCodes).map(([code, count]) => (
            <span
              key={code}
              className="rounded bg-red-900/30 px-1.5 py-0.5 text-[10px] font-medium text-red-400"
            >
              {code}×{count}
            </span>
          ))}
        </div>
      )}

      {/* Mini progress bar */}
      <div className="mt-3">
        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
          {total > 0 && (
            <>
              <div
                className="bg-emerald-500"
                style={{ width: `${(completed / total) * 100}%` }}
              />
              <div
                className="bg-red-500"
                style={{ width: `${(failed / total) * 100}%` }}
              />
              <div
                className="bg-yellow-500"
                style={{ width: `${(pending / total) * 100}%` }}
              />
            </>
          )}
        </div>
        <div className="mt-1 flex gap-3 text-[10px] text-slate-500">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {completed} done
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            {failed} fail
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-yellow-500" />
            {pending} pending
          </span>
        </div>
      </div>
    </button>
  );
};

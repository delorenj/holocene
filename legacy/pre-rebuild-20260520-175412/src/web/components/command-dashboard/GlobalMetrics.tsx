/**
 * GlobalMetrics — Top-level command system health summary.
 *
 * Shows aggregate counts (dispatched, acked, completed, failed),
 * global ack/success rates, and avg latencies.
 */
import React, { useMemo } from 'react';
import type { AgentCommandStats, CommandRecord } from '../../hooks/useCommandStream';

type Props = {
  agentStats: AgentCommandStats[];
  commands: CommandRecord[];
};

function MetricCard({
  label,
  value,
  sub,
  color = 'text-slate-100',
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export const GlobalMetrics: React.FC<Props> = ({ agentStats, commands }) => {
  const metrics = useMemo(() => {
    const total = commands.length;
    const acked = commands.filter(c => c.ackedAt != null).length;
    const completed = commands.filter(c => c.phase === 'completed').length;
    const failed = commands.filter(c => c.phase === 'failed').length;
    const pending = commands.filter(c => c.phase === 'dispatched' || c.phase === 'acked').length;
    const finished = completed + failed;

    const ackLatencies = commands
      .map(c => c.ackLatencyMs)
      .filter((v): v is number => v != null);
    const durations = commands
      .map(c => c.totalDurationMs)
      .filter((v): v is number => v != null);

    const avgAckMs = ackLatencies.length > 0
      ? Math.round(ackLatencies.reduce((a, b) => a + b, 0) / ackLatencies.length)
      : null;
    const p95AckMs = ackLatencies.length > 0
      ? Math.round(ackLatencies.sort((a, b) => a - b)[Math.floor(ackLatencies.length * 0.95)] ?? 0)
      : null;
    const avgDurMs = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

    const ackRate = total > 0 ? acked / total : null;
    const successRate = finished > 0 ? completed / finished : null;

    // Error breakdown
    const errorCodes: Record<string, number> = {};
    for (const c of commands) {
      if (c.errorCode) {
        errorCodes[c.errorCode] = (errorCodes[c.errorCode] ?? 0) + 1;
      }
    }

    return {
      total, acked, completed, failed, pending, finished,
      avgAckMs, p95AckMs, avgDurMs,
      ackRate, successRate, errorCodes,
      activeAgents: agentStats.length,
    };
  }, [commands, agentStats]);

  return (
    <div>
      {/* Top metric cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <MetricCard label="Total Commands" value={metrics.total} />
        <MetricCard
          label="Ack Rate"
          value={metrics.ackRate != null ? `${Math.round(metrics.ackRate * 100)}%` : '—'}
          color={metrics.ackRate != null && metrics.ackRate >= 0.95 ? 'text-emerald-400' : 'text-yellow-400'}
          sub={`${metrics.acked} / ${metrics.total}`}
        />
        <MetricCard
          label="Success Rate"
          value={metrics.successRate != null ? `${Math.round(metrics.successRate * 100)}%` : '—'}
          color={metrics.successRate != null && metrics.successRate >= 0.9 ? 'text-emerald-400' : 'text-red-400'}
          sub={`${metrics.completed} / ${metrics.finished}`}
        />
        <MetricCard
          label="Avg Ack Latency"
          value={metrics.avgAckMs != null ? `${metrics.avgAckMs}ms` : '—'}
          color={metrics.avgAckMs != null && metrics.avgAckMs < 1000 ? 'text-emerald-400' : 'text-yellow-400'}
          sub={metrics.p95AckMs != null ? `p95: ${metrics.p95AckMs}ms` : undefined}
        />
        <MetricCard
          label="Pending"
          value={metrics.pending}
          color={metrics.pending > 5 ? 'text-yellow-400' : 'text-slate-300'}
        />
        <MetricCard
          label="Failed"
          value={metrics.failed}
          color={metrics.failed > 0 ? 'text-red-400' : 'text-slate-300'}
        />
      </div>

      {/* Ack + Success progress bars */}
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
          <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
            <span>Ack Conformance</span>
            <span>{metrics.acked}/{metrics.total}</span>
          </div>
          <ProgressBar value={metrics.acked} max={metrics.total} color="bg-yellow-500" />
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
          <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
            <span>Completion Rate</span>
            <span>{metrics.completed}/{metrics.finished || metrics.total}</span>
          </div>
          <ProgressBar value={metrics.completed} max={metrics.finished || metrics.total} color="bg-emerald-500" />
        </div>
      </div>

      {/* Error breakdown */}
      {Object.keys(metrics.errorCodes).length > 0 && (
        <div className="mt-4 rounded-lg border border-red-900/40 bg-red-950/20 p-3">
          <h4 className="mb-2 text-sm font-medium text-red-300">Error Breakdown</h4>
          <div className="flex flex-wrap gap-2">
            {Object.entries(metrics.errorCodes)
              .sort(([, a], [, b]) => b - a)
              .map(([code, count]) => (
                <span
                  key={code}
                  className="rounded-full bg-red-900/40 px-2.5 py-0.5 text-xs font-medium text-red-300"
                >
                  {code}: {count}
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
};

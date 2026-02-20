import React, { useEffect } from 'react';
import { useDailySummaryStore } from '../../stores/observabilityV2/useDailySummaryStore';

export const DailySummaryPies: React.FC = () => {
  const { summary, isLoading, error, fetchDailySummary, syncPlannedFromActuals } = useDailySummaryStore();

  useEffect(() => {
    fetchDailySummary();
  }, [fetchDailySummary]);

  if (isLoading && !summary) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg bg-slate-900">
        <p className="text-slate-400">Loading daily summary...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg bg-slate-900">
        <p className="text-red-400">Error: {error}</p>
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="rounded-lg bg-slate-900 p-4">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-400">Date: {summary.date}</p>
        <button
          type="button"
          onClick={syncPlannedFromActuals}
          disabled={isLoading}
          className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {isLoading ? 'Syncing...' : 'Sync Planned from Actuals'}
        </button>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Actuals Pie */}
        <div>
          <h4 className="mb-2 text-sm font-semibold text-slate-300">Actual Token Spend Today</h4>
          <div className="rounded border border-slate-700 bg-slate-800 p-4">
            <p className="mb-4 text-center text-xs text-slate-400">
              Pie Chart Placeholder (Recharts in Phase 1)
            </p>
            <div className="space-y-2">
              {summary.actuals.map((item) => (
                <div key={item.projectId} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block h-3 w-3 rounded"
                      style={{ backgroundColor: item.projectColor }}
                    />
                    <span className="text-slate-200">{item.projectName}</span>
                  </div>
                  <span className="font-medium text-slate-100">{item.percentage.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Planned Pie */}
        <div>
          <h4 className="mb-2 text-sm font-semibold text-slate-300">Planned Distribution</h4>
          <div className="rounded border border-slate-700 bg-slate-800 p-4">
            <p className="mb-4 text-center text-xs text-slate-400">
              Pie Chart Placeholder (Recharts in Phase 1)
            </p>
            <div className="space-y-2">
              {summary.planned.map((item) => (
                <div key={item.projectId} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block h-3 w-3 rounded"
                      style={{ backgroundColor: item.projectColor }}
                    />
                    <span className="text-slate-200">{item.projectName}</span>
                  </div>
                  <span className="font-medium text-slate-100">{item.percentage.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Deltas */}
      <div className="mt-4 rounded border border-slate-700 bg-slate-800 p-3">
        <h4 className="mb-2 text-sm font-semibold text-slate-300">Deltas (Actual - Planned)</h4>
        <div className="grid gap-2 md:grid-cols-3">
          {summary.deltas.map((delta) => {
            const actual = summary.actuals.find((a) => a.projectId === delta.projectId);
            return (
              <div key={delta.projectId} className="flex items-center justify-between text-sm">
                <span className="text-slate-300">{actual?.projectName}</span>
                <span
                  className={`font-medium ${
                    delta.severity === 'critical'
                      ? 'text-rose-400'
                      : delta.severity === 'warning'
                      ? 'text-amber-400'
                      : 'text-emerald-400'
                  }`}
                >
                  {delta.delta > 0 ? '+' : ''}
                  {delta.delta.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

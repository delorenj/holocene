import React, { useEffect } from 'react';
import { useObservabilityStore } from '../../stores/observabilityV2/useObservabilityStore';

export const InitiativeBubbleMap: React.FC = () => {
  const {
    initiatives,
    timeRange,
    anomalyThreshold,
    isLoading,
    error,
    fetchInitiatives,
    setTimeRange,
    setAnomalyThreshold,
  } = useObservabilityStore();

  useEffect(() => {
    fetchInitiatives();
  }, [fetchInitiatives]);

  if (isLoading && initiatives.length === 0) {
    return (
      <div className="flex h-96 items-center justify-center rounded-lg bg-slate-900">
        <p className="text-slate-400">Loading initiatives...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-96 items-center justify-center rounded-lg bg-slate-900">
        <p className="text-red-400">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-slate-900 p-4">
      {/* Filter Controls */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex gap-2">
          {(['7d', '30d', 'all'] as const).map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => setTimeRange(range)}
              className={`rounded px-3 py-1 text-sm ${
                timeRange === range
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {range}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="anomaly-threshold" className="text-sm text-slate-400">
            Anomaly threshold:
          </label>
          <input
            id="anomaly-threshold"
            type="range"
            min="500"
            max="50000"
            step="500"
            value={anomalyThreshold}
            onChange={(e) => setAnomalyThreshold(Number(e.target.value))}
            className="w-32"
          />
          <span className="text-sm text-slate-300">{(anomalyThreshold / 1000).toFixed(0)}k</span>
        </div>
      </div>

      {/* Placeholder for bubble chart */}
      <div className="relative h-96 rounded border border-slate-700 bg-slate-800 p-4">
        <p className="mb-4 text-center text-sm text-slate-400">
          Bubble Chart Placeholder (install Recharts in Phase 1)
        </p>

        {/* Temporary list view for MVP */}
        <div className="space-y-2">
          {initiatives.map((init) => (
            <div
              key={init.id}
              className="flex items-center justify-between rounded border border-slate-600 p-3"
              style={{ borderLeftColor: init.projectColor, borderLeftWidth: 4 }}
            >
              <div>
                <p className="font-medium text-slate-100">{init.name}</p>
                <p className="text-xs text-slate-400">
                  {(init.tokenSpend7d / 1000).toFixed(0)}k tokens • {init.progressPercent}% progress
                </p>
              </div>
              {init.isAnomaly && (
                <span className="rounded bg-rose-600 px-2 py-1 text-xs font-semibold text-white">
                  🚨 Anomaly
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

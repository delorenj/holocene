import React from 'react';
import { clsx } from 'clsx';
import { useEchoboxHealth, useEchoboxJobs } from '../../../hooks/useEchoboxLedger';
import type { EchoboxMetrics, JobStatus } from '../../../types/echobox';
import { EchoboxMetricCards } from './EchoboxMetricCards';
import { EchoboxStatusPipeline } from './EchoboxStatusPipeline';
import { EchoboxJobsTable } from './EchoboxJobsTable';

const IN_PROGRESS_STATUSES: JobStatus[] = [
  'hashing',
  'uploading',
  'uploaded',
  'transcribing',
  'ready',
  'writing',
];

export function EchoboxDashboard() {
  const {
    data: health,
    isError: healthError,
    isLoading: healthLoading,
  } = useEchoboxHealth();

  const { data: jobs = [], isLoading: jobsLoading } = useEchoboxJobs();

  const metrics: EchoboxMetrics = React.useMemo(() => {
    const total = jobs.length;
    const completed = jobs.filter((j) => j.status === 'completed').length;
    const failed = jobs.filter((j) => j.status === 'failed').length;
    const skipped = jobs.filter((j) => j.status === 'skipped').length;
    const inProgress = jobs.filter((j) =>
      IN_PROGRESS_STATUSES.includes(j.status)
    ).length;
    const pending = jobs.filter((j) => j.status === 'detected').length;

    return { total, completed, failed, skipped, inProgress, pending };
  }, [jobs]);

  const isLoading = jobsLoading;

  const isHealthy =
    !healthError && !healthLoading && health?.status === 'ok' && health?.db_connected;

  const isLedgerDown = healthError || (!healthLoading && health && !health.db_connected);

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100">Echobox</h2>
          <p className="text-sm text-slate-400">Transcription Service</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Ledger</span>
          <span
            className={clsx(
              'h-2.5 w-2.5 rounded-full',
              healthLoading
                ? 'animate-pulse bg-slate-500'
                : isHealthy
                ? 'bg-emerald-500'
                : 'bg-red-500'
            )}
            title={
              healthLoading
                ? 'Checking...'
                : isHealthy
                ? 'Connected'
                : 'Disconnected'
            }
          />
          {!healthLoading && (
            <span
              className={clsx(
                'text-xs',
                isHealthy ? 'text-emerald-400' : 'text-red-400'
              )}
            >
              {isHealthy ? 'Connected' : 'Disconnected'}
            </span>
          )}
        </div>
      </div>

      {/* Ledger down warning banner */}
      {isLedgerDown && (
        <div className="mx-6 mt-4 flex items-center gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3">
          <span className="text-yellow-400 text-lg">&#9888;</span>
          <div>
            <p className="text-sm font-medium text-yellow-300">
              Echobox ledger is unreachable
            </p>
            <p className="text-xs text-yellow-500">
              Job data may be stale. The service will retry automatically.
            </p>
          </div>
        </div>
      )}

      {/* Metrics row */}
      <EchoboxMetricCards metrics={metrics} isLoading={isLoading} />

      {/* Pipeline visualization */}
      <EchoboxStatusPipeline jobs={jobs} />

      {/* Jobs table */}
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <EchoboxJobsTable jobs={jobs} isLoading={isLoading} />
      </div>
    </div>
  );
}

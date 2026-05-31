import React from 'react';
import { clsx } from 'clsx';
import type { EchoboxJob, JobStatus } from '../../../types/echobox';

interface EchoboxStatusPipelineProps {
  jobs: EchoboxJob[];
}

const PIPELINE_STAGES: JobStatus[] = [
  'detected',
  'hashing',
  'uploading',
  'uploaded',
  'transcribing',
  'ready',
  'writing',
  'completed',
];

const stageStyles: Record<JobStatus, { bubble: string; label: string }> = {
  detected: {
    bubble: 'bg-slate-500/20 border-slate-500/40 text-slate-300',
    label: 'text-slate-400',
  },
  hashing: {
    bubble: 'bg-blue-500/20 border-blue-500/40 text-blue-300',
    label: 'text-blue-400',
  },
  uploading: {
    bubble: 'bg-blue-500/20 border-blue-500/40 text-blue-300',
    label: 'text-blue-400',
  },
  uploaded: {
    bubble: 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300',
    label: 'text-indigo-400',
  },
  transcribing: {
    bubble: 'bg-amber-500/20 border-amber-500/40 text-amber-300',
    label: 'text-amber-400',
  },
  ready: {
    bubble: 'bg-purple-500/20 border-purple-500/40 text-purple-300',
    label: 'text-purple-400',
  },
  writing: {
    bubble: 'bg-purple-500/20 border-purple-500/40 text-purple-300',
    label: 'text-purple-400',
  },
  completed: {
    bubble: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300',
    label: 'text-emerald-400',
  },
  failed: {
    bubble: 'bg-red-500/20 border-red-500/40 text-red-300',
    label: 'text-red-400',
  },
  skipped: {
    bubble: 'bg-slate-500/20 border-slate-500/40 text-slate-300',
    label: 'text-slate-400',
  },
};

const stageLabels: Record<JobStatus, string> = {
  detected: 'Detected',
  hashing: 'Hashing',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  transcribing: 'Transcribing',
  ready: 'Ready',
  writing: 'Writing',
  completed: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
};

export function EchoboxStatusPipeline({ jobs }: EchoboxStatusPipelineProps) {
  const counts = React.useMemo(() => {
    const map: Partial<Record<JobStatus, number>> = {};
    for (const job of jobs) {
      map[job.status] = (map[job.status] ?? 0) + 1;
    }
    return map;
  }, [jobs]);

  const failedCount = counts['failed'] ?? 0;

  return (
    <div className="px-6 py-3">
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">
          Pipeline
        </p>

        {/* Main pipeline flow */}
        <div className="flex items-center gap-1 overflow-x-auto pb-2">
          {PIPELINE_STAGES.map((stage, index) => {
            const count = counts[stage] ?? 0;
            const styles = stageStyles[stage];
            const isLast = index === PIPELINE_STAGES.length - 1;

            return (
              <React.Fragment key={stage}>
                <div className="flex flex-col items-center gap-1 min-w-[64px]">
                  <div
                    className={clsx(
                      'flex h-10 w-14 items-center justify-center rounded-lg border text-sm font-bold',
                      styles.bubble,
                      count > 0 && 'ring-1 ring-current ring-offset-1 ring-offset-slate-900'
                    )}
                  >
                    {count}
                  </div>
                  <span className={clsx('text-xs font-medium', styles.label)}>
                    {stageLabels[stage]}
                  </span>
                </div>

                {!isLast && (
                  <div className="flex-shrink-0 text-slate-600 text-lg pb-4">
                    &rsaquo;
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Failed branch */}
        {failedCount > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <div className="h-px w-8 bg-red-500/30" />
            <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5">
              <span className="text-xs font-medium text-red-400">Failed</span>
              <span className="text-sm font-bold text-red-300">{failedCount}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

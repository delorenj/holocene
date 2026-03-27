import React from 'react';
import { clsx } from 'clsx';
import type { JobStatus } from '../../../types/echobox';

interface JobStatusBadgeProps {
  status: JobStatus;
}

const statusStyles: Record<JobStatus, string> = {
  detected: 'bg-slate-500/20 text-slate-400',
  skipped: 'bg-slate-500/20 text-slate-400',
  hashing: 'bg-blue-500/20 text-blue-400',
  uploading: 'bg-blue-500/20 text-blue-400',
  uploaded: 'bg-indigo-500/20 text-indigo-400',
  transcribing: 'bg-amber-500/20 text-amber-400',
  ready: 'bg-purple-500/20 text-purple-400',
  writing: 'bg-purple-500/20 text-purple-400',
  completed: 'bg-emerald-500/20 text-emerald-400',
  failed: 'bg-red-500/20 text-red-400',
};

const statusLabels: Record<JobStatus, string> = {
  detected: 'Detected',
  skipped: 'Skipped',
  hashing: 'Hashing',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  transcribing: 'Transcribing',
  ready: 'Ready',
  writing: 'Writing',
  completed: 'Completed',
  failed: 'Failed',
};

export function JobStatusBadge({ status }: JobStatusBadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
        statusStyles[status]
      )}
    >
      {statusLabels[status]}
    </span>
  );
}

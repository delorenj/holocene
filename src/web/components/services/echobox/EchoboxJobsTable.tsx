import React, { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../../ui/table';
import { JobStatusBadge } from './JobStatusBadge';
import type { EchoboxJob } from '../../../types/echobox';

interface EchoboxJobsTableProps {
  jobs: EchoboxJob[];
  isLoading: boolean;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true });
  } catch {
    return dateStr;
  }
}

function truncateFilename(filename: string, maxLen = 40): string {
  if (filename.length <= maxLen) return filename;
  const ext = filename.lastIndexOf('.');
  if (ext > 0) {
    const base = filename.slice(0, maxLen - 4 - (filename.length - ext));
    return `${base}...${filename.slice(ext)}`;
  }
  return `${filename.slice(0, maxLen - 3)}...`;
}

export function EchoboxJobsTable({ jobs, isLoading }: EchoboxJobsTableProps) {
  const [sortDesc, setSortDesc] = useState(true);

  const sorted = React.useMemo(() => {
    return [...jobs].sort((a, b) => {
      const tA = new Date(a.created_at).getTime();
      const tB = new Date(b.created_at).getTime();
      return sortDesc ? tB - tA : tA - tB;
    });
  }, [jobs, sortDesc]);

  if (isLoading) {
    return (
      <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900">
        <div className="p-8 text-center text-sm text-slate-500">Loading jobs...</div>
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900">
        <div className="p-8 text-center">
          <p className="text-sm text-slate-500">No jobs found</p>
          <p className="mt-1 text-xs text-slate-600">
            Jobs will appear here once files are detected by Echobox.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900">
      <div className="border-b border-slate-800 px-4 py-3">
        <h3 className="text-sm font-medium text-slate-300">
          Recent Jobs
          <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
            {jobs.length}
          </span>
        </h3>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Filename</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>
              <button
                type="button"
                onClick={() => setSortDesc((d) => !d)}
                className="flex items-center gap-1 uppercase tracking-wider hover:text-slate-200 transition-colors"
              >
                Created
                <span className="text-slate-600">{sortDesc ? '↓' : '↑'}</span>
              </button>
            </TableHead>
            <TableHead>Completed</TableHead>
            <TableHead>Error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((job) => (
            <TableRow key={job.job_id}>
              <TableCell>
                <span
                  className="font-mono text-xs text-slate-200"
                  title={job.source_filename}
                >
                  {truncateFilename(job.source_filename)}
                </span>
              </TableCell>
              <TableCell>
                <JobStatusBadge status={job.status} />
              </TableCell>
              <TableCell className="text-xs text-slate-400">
                {formatDate(job.created_at)}
              </TableCell>
              <TableCell className="text-xs text-slate-400">
                {formatDate(job.completed_at)}
              </TableCell>
              <TableCell>
                {job.error_message ? (
                  <span
                    className="text-xs text-red-400 font-mono"
                    title={job.error_message}
                  >
                    [{job.error_stage ?? 'unknown'}]{' '}
                    {job.error_message.length > 40
                      ? `${job.error_message.slice(0, 40)}...`
                      : job.error_message}
                  </span>
                ) : (
                  <span className="text-slate-700">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

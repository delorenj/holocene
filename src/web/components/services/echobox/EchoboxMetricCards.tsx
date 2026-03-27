import React from 'react';
import { clsx } from 'clsx';
import { Card } from '../../atoms/Card';
import type { EchoboxMetrics } from '../../../types/echobox';

interface MetricCardProps {
  label: string;
  value: number;
  valueClass: string;
  isLoading: boolean;
}

function MetricCard({ label, value, valueClass, isLoading }: MetricCardProps) {
  return (
    <Card
      variant="default"
      padding="md"
      className="flex-1 bg-slate-900 border-slate-800 min-w-0"
    >
      <div className="flex flex-col gap-1">
        <span className={clsx('text-2xl font-bold tabular-nums', valueClass)}>
          {isLoading ? (
            <span className="inline-block h-7 w-10 animate-pulse rounded bg-slate-700" />
          ) : (
            value
          )}
        </span>
        <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
          {label}
        </span>
      </div>
    </Card>
  );
}

interface EchoboxMetricCardsProps {
  metrics: EchoboxMetrics;
  isLoading: boolean;
}

export function EchoboxMetricCards({ metrics, isLoading }: EchoboxMetricCardsProps) {
  return (
    <div className="flex gap-3 px-6 py-4">
      <MetricCard
        label="Total Jobs"
        value={metrics.total}
        valueClass="text-slate-200"
        isLoading={isLoading}
      />
      <MetricCard
        label="In Progress"
        value={metrics.inProgress}
        valueClass="text-amber-400"
        isLoading={isLoading}
      />
      <MetricCard
        label="Completed"
        value={metrics.completed}
        valueClass="text-emerald-400"
        isLoading={isLoading}
      />
      <MetricCard
        label="Failed"
        value={metrics.failed}
        valueClass="text-red-400"
        isLoading={isLoading}
      />
      <MetricCard
        label="Deduped"
        value={metrics.skipped}
        valueClass="text-slate-400"
        isLoading={isLoading}
      />
    </div>
  );
}

import React, { useState } from 'react';
import { clsx } from 'clsx';
import { EchoboxDashboard } from './echobox/EchoboxDashboard';
import { useEchoboxHealth } from '../../hooks/useEchoboxLedger';

type ServiceId = 'echobox';

interface ServiceDefinition {
  id: ServiceId;
  name: string;
  description: string;
  metricLabel: string;
}

const SERVICES: ServiceDefinition[] = [
  {
    id: 'echobox',
    name: 'Echobox',
    description: 'Audio/video transcription pipeline with deduplication and Fireflies integration.',
    metricLabel: 'Pending jobs',
  },
];

function EchoboxServiceCard({
  service,
  onSelect,
}: {
  service: ServiceDefinition;
  onSelect: () => void;
}) {
  const { data: health, isError, isLoading } = useEchoboxHealth();

  const isHealthy =
    !isError && !isLoading && health?.status === 'ok' && health?.db_connected;

  const pendingJobs = health?.pending_jobs ?? 0;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={clsx(
        'group flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900 p-5 text-left',
        'transition-all hover:border-slate-700 hover:bg-slate-800/60',
        'focus:outline-none focus:ring-2 focus:ring-slate-600'
      )}
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-100 group-hover:text-white">
            {service.name}
          </h3>
          <p className="mt-1 text-sm text-slate-400">{service.description}</p>
        </div>
        <span
          className={clsx(
            'mt-0.5 h-2.5 w-2.5 flex-shrink-0 rounded-full',
            isLoading
              ? 'animate-pulse bg-slate-500'
              : isHealthy
              ? 'bg-emerald-500'
              : 'bg-red-500'
          )}
          title={isLoading ? 'Checking...' : isHealthy ? 'Online' : 'Offline'}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">{service.metricLabel}:</span>
        <span className="text-xs font-semibold text-slate-300">
          {isLoading ? '...' : pendingJobs}
        </span>
      </div>

      <div className="text-xs text-slate-600 group-hover:text-slate-500">
        Click to open dashboard &rsaquo;
      </div>
    </button>
  );
}

export function ServicesView() {
  const [selectedService, setSelectedService] = useState<ServiceId | null>(null);

  if (selectedService === 'echobox') {
    return (
      <div className="flex h-full flex-col bg-slate-950">
        <div className="flex items-center gap-3 border-b border-slate-800 px-6 py-3">
          <button
            type="button"
            onClick={() => setSelectedService(null)}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
          >
            <span>&lsaquo;</span>
            <span>Services</span>
          </button>
          <span className="text-slate-700">/</span>
          <span className="text-sm font-medium text-slate-300">Echobox</span>
        </div>
        <div className="flex-1 overflow-hidden">
          <EchoboxDashboard />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <div className="border-b border-slate-800 px-6 py-4">
        <h2 className="text-xl font-bold text-slate-100">Services</h2>
        <p className="mt-0.5 text-sm text-slate-400">
          Monitor and manage platform services
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SERVICES.map((service) => (
            <EchoboxServiceCard
              key={service.id}
              service={service}
              onSelect={() => setSelectedService(service.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

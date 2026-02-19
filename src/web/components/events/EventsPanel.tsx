import React, { useMemo, useState, useCallback } from 'react';
import { useBloodbankStream, type BloodbankEvent } from '../../hooks/useBloodbankStream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EventSummary = {
  id: string;
  timestamp: string;
  routingKey: string;
  agentName: string;
  action: string;
  envelope: Record<string, unknown>;
  payload: Record<string, unknown>;
};

function formatTimestamp(iso?: string): string {
  if (!iso) return '--:--:--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString([], { hour12: false });
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function deriveSummary(event: BloodbankEvent, idx: number): EventSummary {
  const envelope = normalizeRecord(event.envelope);
  const payload = normalizeRecord(envelope.payload);

  const routingKey =
    event.routing_key ||
    (typeof envelope.event_type === 'string' ? envelope.event_type : '') ||
    'unknown';

  const routingParts = routingKey.split('.').filter(Boolean);

  const payloadAgentName = typeof payload.agent_name === 'string' ? payload.agent_name : null;
  const derivedAgentName =
    payloadAgentName ||
    (routingParts[0] === 'agent' && routingParts[1] ? routingParts[1] : null) ||
    (typeof payload.agent_id === 'string' ? payload.agent_id : null) ||
    '—';

  const action =
    (routingParts[0] === 'agent' && routingParts.length >= 3
      ? routingParts.slice(2).join('.')
      : routingParts.slice(-1)[0]) || 'unknown';

  const eventId =
    (typeof envelope.event_id === 'string' && envelope.event_id) ||
    `${routingKey}:${String(envelope.timestamp || idx)}`;

  return {
    id: eventId,
    timestamp: formatTimestamp(typeof envelope.timestamp === 'string' ? envelope.timestamp : undefined),
    routingKey,
    agentName: derivedAgentName,
    action,
    envelope,
    payload,
  };
}

function getBadgeColor(routingKey: string): string {
  if (routingKey.includes('error')) return 'bg-red-600/20 text-red-300 border-red-500/40';
  if (routingKey.includes('tool')) return 'bg-amber-600/20 text-amber-300 border-amber-500/40';
  if (routingKey.includes('heartbeat')) return 'bg-emerald-600/20 text-emerald-300 border-emerald-500/40';
  if (routingKey.includes('message')) return 'bg-blue-600/20 text-blue-300 border-blue-500/40';
  return 'bg-slate-700/30 text-slate-300 border-slate-600';
}

// ---------------------------------------------------------------------------
// Event Row
// ---------------------------------------------------------------------------

interface EventRowProps {
  event: EventSummary;
  expanded: boolean;
  onToggle: () => void;
}

const EventRow: React.FC<EventRowProps> = ({ event, expanded, onToggle }) => {
  return (
    <div className="border-b border-slate-800 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full grid-cols-[90px_1fr_140px_160px_24px] items-center gap-3 px-4 py-2 text-left hover:bg-slate-800/40"
      >
        <span className="font-mono text-xs text-slate-400">{event.timestamp}</span>

        <span
          className={`truncate rounded border px-2 py-0.5 text-xs ${getBadgeColor(event.routingKey)}`}
          title={event.routingKey}
        >
          {event.routingKey}
        </span>

        <span className="truncate text-xs text-slate-200" title={event.agentName}>
          {event.agentName}
        </span>

        <span className="truncate text-xs text-slate-400" title={event.action}>
          {event.action}
        </span>

        <span className="text-xs text-slate-500">{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded ? (
        <div className="grid gap-3 bg-slate-950/50 px-4 pb-4 pl-[102px]">
          <div>
            <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Envelope</p>
            <pre className="overflow-x-auto rounded border border-slate-800 bg-slate-950 p-3 text-[11px] text-slate-300">
              {JSON.stringify(event.envelope, null, 2)}
            </pre>
          </div>

          <div>
            <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Payload</p>
            <pre className="overflow-x-auto rounded border border-slate-800 bg-slate-950 p-3 text-[11px] text-slate-300">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Toolbar + Header
// ---------------------------------------------------------------------------

interface ToolbarProps {
  connected: boolean;
  onClear: () => void;
  panelVisible: boolean;
  onTogglePanel: () => void;
}

const Toolbar: React.FC<ToolbarProps> = ({ connected, onClear, panelVisible, onTogglePanel }) => {
  return (
    <div className="border-b border-slate-800 bg-slate-950 px-4 py-3">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">Bloodbank Events</h2>

        <div className="flex items-center gap-2">
          <span className="flex items-center gap-2 text-xs text-slate-400">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`} />
            {connected ? 'Connected' : 'Disconnected'}
          </span>

          <button
            type="button"
            onClick={onTogglePanel}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            {panelVisible ? 'Hide Panel' : 'Show Panel'}
          </button>

          <button
            type="button"
            onClick={onClear}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Reserved toolbar area for future search/filter */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          disabled
          placeholder="Search events (coming soon)"
          className="h-8 w-full max-w-sm rounded border border-slate-800 bg-slate-900 px-2 text-xs text-slate-500 placeholder:text-slate-500"
        />

        <select
          disabled
          className="h-8 min-w-36 rounded border border-slate-800 bg-slate-900 px-2 text-xs text-slate-500"
          defaultValue=""
        >
          <option value="">Filter by agent (coming soon)</option>
        </select>

        <select
          disabled
          className="h-8 min-w-36 rounded border border-slate-800 bg-slate-900 px-2 text-xs text-slate-500"
          defaultValue=""
        >
          <option value="">Filter by action (coming soon)</option>
        </select>
      </div>
    </div>
  );
};

const EmptyState: React.FC<{ panelVisible: boolean }> = ({ panelVisible }) => {
  if (!panelVisible) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        Events panel hidden
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-slate-500">
      <span className="text-2xl">⚡</span>
      <p>Waiting for events from Bloodbank…</p>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export const EventsPanel: React.FC = () => {
  const { events, connected, clearEvents } = useBloodbankStream();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [panelVisible, setPanelVisible] = useState(true);

  const summarized = useMemo(() => events.map((event, idx) => deriveSummary(event, idx)), [events]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const togglePanel = useCallback(() => {
    setPanelVisible((prev) => !prev);
  }, []);

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <Toolbar connected={connected} onClear={clearEvents} panelVisible={panelVisible} onTogglePanel={togglePanel} />

      <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-2 text-[11px] uppercase tracking-wide text-slate-500">
        <span className="w-[90px]">Timestamp</span>
        <span className="flex-1">Routing Key</span>
        <span className="w-[140px]">Agent</span>
        <span className="w-[160px]">Action</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!panelVisible || summarized.length === 0 ? (
          <EmptyState panelVisible={panelVisible} />
        ) : (
          summarized.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              expanded={expanded.has(event.id)}
              onToggle={() => toggleExpanded(event.id)}
            />
          ))
        )}
      </div>
    </div>
  );
};

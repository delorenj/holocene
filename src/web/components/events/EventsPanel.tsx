import React, { useState, useCallback } from 'react';
import { useBloodbankStream, type BloodbankEvent } from '../../hooks/useBloodbankStream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function truncateEventId(id: string, maxLen = 16): string {
  if (id.length <= maxLen) return id;
  return `${id.slice(0, maxLen)}…`;
}

function getRoutingKeyColor(routingKey: string): string {
  if (routingKey.includes('message')) return 'bg-blue-600';
  if (routingKey.includes('tool')) return 'bg-amber-600';
  if (routingKey.includes('subagent')) return 'bg-purple-600';
  if (routingKey.includes('heartbeat')) return 'bg-emerald-600';
  if (routingKey.includes('error')) return 'bg-red-600';
  return 'bg-slate-600';
}

// ---------------------------------------------------------------------------
// Event Row Component
// ---------------------------------------------------------------------------

interface EventRowProps {
  event: BloodbankEvent;
  isExpanded: boolean;
  onToggle: () => void;
}

const EventRow: React.FC<EventRowProps> = ({ event, isExpanded, onToggle }) => {
  const routingKey = event.routing_key ?? 'unknown';
  const eventType = event.envelope?.event_type ?? 'unknown';
  const eventId = event.envelope?.event_id ?? 'unknown';
  const timestamp = event.envelope?.timestamp;
  const relativeTime = timestamp ? getRelativeTime(timestamp) : '--';
  const badgeColor = getRoutingKeyColor(routingKey);

  return (
    <div
      className="border-b border-slate-800 last:border-b-0 transition-colors hover:bg-slate-800/50 cursor-pointer"
      onClick={onToggle}
    >
      {/* Main row */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Relative timestamp */}
        <span className="shrink-0 w-16 text-xs text-slate-500 font-mono">
          {relativeTime}
        </span>

        {/* Routing key badge */}
        <span
          className={`shrink-0 max-w-[120px] truncate px-2 py-0.5 rounded text-[10px] font-medium text-white ${badgeColor}`}
          title={routingKey}
        >
          {routingKey.split('.').pop() ?? routingKey}
        </span>

        {/* Event type */}
        <span className="shrink-0 text-xs text-slate-400 w-24 truncate">
          {eventType}
        </span>

        {/* Event ID */}
        <span className="text-xs text-slate-600 font-mono truncate flex-1 min-w-0">
          {truncateEventId(eventId)}
        </span>

        {/* Expand indicator */}
        <span className="shrink-0 text-xs text-slate-500">
          {isExpanded ? '▼' : '▶'}
        </span>
      </div>

      {/* Expanded JSON view */}
      {isExpanded && (
        <div className="px-4 pb-4 bg-slate-900/50">
          <div className="pl-[76px]">
            <pre className="text-[11px] font-mono text-slate-300 bg-slate-950 rounded p-3 overflow-x-auto border border-slate-800">
              {JSON.stringify(event, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Connection Indicator
// ---------------------------------------------------------------------------

interface ConnectionIndicatorProps {
  connected: boolean;
}

const ConnectionIndicator: React.FC<ConnectionIndicatorProps> = ({ connected }) => (
  <div className="flex items-center gap-2">
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${
        connected ? 'bg-emerald-400' : 'bg-red-500'
      }`}
    />
    <span className="text-xs text-slate-400">
      {connected ? 'Connected' : 'Disconnected'}
    </span>
  </div>
);

// ---------------------------------------------------------------------------
// Toolbar Component
// ---------------------------------------------------------------------------

interface ToolbarProps {
  onClear: () => void;
  connected: boolean;
}

const Toolbar: React.FC<ToolbarProps> = ({ onClear, connected }) => (
  <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-950">
    <div className="flex items-center gap-4 flex-1">
      {/* Search placeholder */}
      <div className="flex-1 max-w-xs">
        <div className="h-8 rounded-md bg-slate-900 border border-slate-800" />
      </div>

      {/* Filter dropdown placeholders */}
      <div className="hidden sm:flex items-center gap-2">
        <div className="h-8 w-28 rounded-md bg-slate-900 border border-slate-800" />
        <div className="h-8 w-28 rounded-md bg-slate-900 border border-slate-800" />
      </div>
    </div>

    <div className="flex items-center gap-3">
      <ConnectionIndicator connected={connected} />
      <button
        type="button"
        onClick={onClear}
        className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-md transition-colors"
      >
        Clear
      </button>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Empty State
// ---------------------------------------------------------------------------

const EmptyState: React.FC = () => (
  <div className="flex flex-col items-center justify-center py-16 text-center">
    <div className="text-4xl mb-3">⚡</div>
    <p className="text-sm text-slate-500">
      No events yet — waiting for Bloodbank...
    </p>
  </div>
);

// ---------------------------------------------------------------------------
// Main EventsPanel Component
// ---------------------------------------------------------------------------

export const EventsPanel: React.FC = () => {
  const { events, connected, clearEvents } = useBloodbankStream();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((eventId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  }, []);

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <Toolbar onClear={clearEvents} connected={connected} />

      <div className="flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <EmptyState />
        ) : (
          <div>
            {events.map((event) => {
              const eventId = event.envelope?.event_id ?? `evt-${Math.random()}`;
              return (
                <EventRow
                  key={eventId}
                  event={event}
                  isExpanded={expandedIds.has(eventId)}
                  onToggle={() => toggleExpanded(eventId)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

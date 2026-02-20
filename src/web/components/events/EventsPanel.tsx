import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useBloodbankStream, type BloodbankEvent } from '../../hooks/useBloodbankStream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EventSummary = {
  id: string;
  timestamp: string;
  timestampDate: Date;
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

function parseTimestamp(iso?: string): Date {
  if (!iso) return new Date();
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? new Date() : date;
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

  const timestampIso = typeof envelope.timestamp === 'string' ? envelope.timestamp : undefined;

  return {
    id: eventId,
    timestamp: formatTimestamp(timestampIso),
    timestampDate: parseTimestamp(timestampIso),
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
  searchQuery: string;
  onSearchChange: (query: string) => void;
  agentFilter: string;
  onAgentFilterChange: (agent: string) => void;
  eventTypeFilter: string;
  onEventTypeFilterChange: (type: string) => void;
  timeRangeFilter: string;
  onTimeRangeFilterChange: (range: string) => void;
  autoScroll: boolean;
  onToggleAutoScroll: () => void;
  availableAgents: string[];
  availableEventTypes: string[];
}

const Toolbar: React.FC<ToolbarProps> = ({
  connected,
  onClear,
  panelVisible,
  onTogglePanel,
  searchQuery,
  onSearchChange,
  agentFilter,
  onAgentFilterChange,
  eventTypeFilter,
  onEventTypeFilterChange,
  timeRangeFilter,
  onTimeRangeFilterChange,
  autoScroll,
  onToggleAutoScroll,
  availableAgents,
  availableEventTypes,
}) => {
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
            onClick={onToggleAutoScroll}
            className={`rounded border px-2 py-1 text-xs ${
              autoScroll
                ? 'border-emerald-600 bg-emerald-600/20 text-emerald-300'
                : 'border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
          >
            {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
          </button>

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

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search events..."
          className="h-8 w-full max-w-sm rounded border border-slate-800 bg-slate-900 px-2 text-xs text-slate-300 placeholder:text-slate-500 focus:border-slate-600 focus:outline-none"
        />

        <select
          value={agentFilter}
          onChange={(e) => onAgentFilterChange(e.target.value)}
          className="h-8 min-w-36 rounded border border-slate-800 bg-slate-900 px-2 text-xs text-slate-300 focus:border-slate-600 focus:outline-none"
        >
          <option value="">All agents</option>
          {availableAgents.map((agent) => (
            <option key={agent} value={agent}>
              {agent}
            </option>
          ))}
        </select>

        <select
          value={eventTypeFilter}
          onChange={(e) => onEventTypeFilterChange(e.target.value)}
          className="h-8 min-w-36 rounded border border-slate-800 bg-slate-900 px-2 text-xs text-slate-300 focus:border-slate-600 focus:outline-none"
        >
          <option value="">All event types</option>
          {availableEventTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>

        <select
          value={timeRangeFilter}
          onChange={(e) => onTimeRangeFilterChange(e.target.value)}
          className="h-8 min-w-36 rounded border border-slate-800 bg-slate-900 px-2 text-xs text-slate-300 focus:border-slate-600 focus:outline-none"
        >
          <option value="">All time</option>
          <option value="5m">Last 5 minutes</option>
          <option value="15m">Last 15 minutes</option>
          <option value="1h">Last hour</option>
          <option value="6h">Last 6 hours</option>
          <option value="24h">Last 24 hours</option>
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
  const [searchQuery, setSearchQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [timeRangeFilter, setTimeRangeFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [isHovering, setIsHovering] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const summarized = useMemo(() => events.map((event, idx) => deriveSummary(event, idx)), [events]);

  // Extract unique agents and event types for filter dropdowns
  const { availableAgents, availableEventTypes } = useMemo(() => {
    const agents = new Set<string>();
    const types = new Set<string>();
    
    summarized.forEach((event) => {
      if (event.agentName !== '—') {
        agents.add(event.agentName);
      }
      types.add(event.routingKey);
    });

    return {
      availableAgents: Array.from(agents).sort(),
      availableEventTypes: Array.from(types).sort(),
    };
  }, [summarized]);

  // Filter events based on all criteria
  const filteredEvents = useMemo(() => {
    let result = summarized;

    // Search query (searches in routing key, agent name, action, and payload)
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter((event) => {
        const payloadStr = JSON.stringify(event.payload).toLowerCase();
        return (
          event.routingKey.toLowerCase().includes(query) ||
          event.agentName.toLowerCase().includes(query) ||
          event.action.toLowerCase().includes(query) ||
          payloadStr.includes(query)
        );
      });
    }

    // Agent filter
    if (agentFilter) {
      result = result.filter((event) => event.agentName === agentFilter);
    }

    // Event type filter
    if (eventTypeFilter) {
      result = result.filter((event) => event.routingKey === eventTypeFilter);
    }

    // Time range filter
    if (timeRangeFilter) {
      const now = Date.now();
      const ranges: Record<string, number> = {
        '5m': 5 * 60 * 1000,
        '15m': 15 * 60 * 1000,
        '1h': 60 * 60 * 1000,
        '6h': 6 * 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000,
      };
      const rangeMs = ranges[timeRangeFilter];
      if (rangeMs) {
        result = result.filter((event) => now - event.timestampDate.getTime() <= rangeMs);
      }
    }

    return result;
  }, [summarized, searchQuery, agentFilter, eventTypeFilter, timeRangeFilter]);

  // Auto-scroll to top when new events arrive (unless hovering)
  useEffect(() => {
    if (autoScroll && !isHovering && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [filteredEvents, autoScroll, isHovering]);

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

  const toggleAutoScroll = useCallback(() => {
    setAutoScroll((prev) => !prev);
  }, []);

  const handleMouseEnter = useCallback(() => {
    setIsHovering(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsHovering(false);
  }, []);

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <Toolbar
        connected={connected}
        onClear={clearEvents}
        panelVisible={panelVisible}
        onTogglePanel={togglePanel}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        agentFilter={agentFilter}
        onAgentFilterChange={setAgentFilter}
        eventTypeFilter={eventTypeFilter}
        onEventTypeFilterChange={setEventTypeFilter}
        timeRangeFilter={timeRangeFilter}
        onTimeRangeFilterChange={setTimeRangeFilter}
        autoScroll={autoScroll}
        onToggleAutoScroll={toggleAutoScroll}
        availableAgents={availableAgents}
        availableEventTypes={availableEventTypes}
      />

      <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-2 text-[11px] uppercase tracking-wide text-slate-500">
        <span className="w-[90px]">Timestamp</span>
        <span className="flex-1">Routing Key</span>
        <span className="w-[140px]">Agent</span>
        <span className="w-[160px]">Action</span>
      </div>

      <div
        ref={scrollContainerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="flex-1 overflow-y-auto"
      >
        {!panelVisible || filteredEvents.length === 0 ? (
          <EmptyState panelVisible={panelVisible} />
        ) : (
          filteredEvents.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              expanded={expanded.has(event.id)}
              onToggle={() => toggleExpanded(event.id)}
            />
          ))
        )}
      </div>

      {/* Active filters indicator */}
      {panelVisible && (searchQuery || agentFilter || eventTypeFilter || timeRangeFilter) && (
        <div className="border-t border-slate-800 bg-slate-900/50 px-4 py-2 text-xs text-slate-400">
          Showing {filteredEvents.length} of {summarized.length} events
          {searchQuery && <span className="ml-2">• Search: "{searchQuery}"</span>}
          {agentFilter && <span className="ml-2">• Agent: {agentFilter}</span>}
          {eventTypeFilter && <span className="ml-2">• Type: {eventTypeFilter}</span>}
          {timeRangeFilter && <span className="ml-2">• Time: {timeRangeFilter}</span>}
        </div>
      )}
    </div>
  );
};

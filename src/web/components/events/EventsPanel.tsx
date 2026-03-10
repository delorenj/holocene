import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useBloodbankStream, type BloodbankEvent } from '../../hooks/useBloodbankStream';
import { useEventHistory } from '../../hooks/useEventHistory';

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

const HEARTBEAT_SYSTEM_FILTER = '__heartbeat_system';
const HEARTBEAT_AGENT_FILTER = '__heartbeat_agent';

function isSystemHeartbeat(routingKey: string): boolean {
  return routingKey.startsWith('system.heartbeat.');
}

function isAgentHeartbeat(routingKey: string): boolean {
  return /^agent\.[^.]+\.heartbeat(\.|$)/.test(routingKey);
}

function normalizeEventTypeForFilter(routingKey: string): string {
  if (isSystemHeartbeat(routingKey)) return HEARTBEAT_SYSTEM_FILTER;
  if (isAgentHeartbeat(routingKey)) return HEARTBEAT_AGENT_FILTER;
  return routingKey;
}

function eventTypeFilterLabel(value: string): string {
  if (value === HEARTBEAT_SYSTEM_FILTER) return 'system heartbeat';
  if (value === HEARTBEAT_AGENT_FILTER) return 'agent heartbeat';
  return value;
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
              {eventTypeFilterLabel(type)}
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

const EmptyState: React.FC<{ panelVisible: boolean; loading?: boolean }> = ({
  panelVisible,
  loading,
}) => {
  if (!panelVisible) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        Events panel hidden
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full flex-col gap-0">
        {/* Skeleton loading rows */}
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[90px_1fr_140px_160px_24px] items-center gap-3 border-b border-slate-800 px-4 py-2 animate-pulse"
          >
            <div className="h-4 bg-slate-800 rounded w-16" />
            <div className="h-4 bg-slate-800 rounded w-3/4" />
            <div className="h-4 bg-slate-800 rounded w-20" />
            <div className="h-4 bg-slate-800 rounded w-24" />
            <div className="h-4 bg-slate-800 rounded w-4" />
          </div>
        ))}
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
  const { events: liveEvents, connected, clearEvents } = useBloodbankStream();
  const [historicalOffset, setHistoricalOffset] = useState(0);
  const { events: historicalEvents, loading: historyLoading, hasMore } = useEventHistory({ 
    limit: 50,
    offset: historicalOffset,
    enablePolling: false, // Disabled — WS handles live events
  });
  const [allHistoricalEvents, setAllHistoricalEvents] = useState<BloodbankEvent[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [panelVisible, setPanelVisible] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [timeRangeFilter, setTimeRangeFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [isHovering, setIsHovering] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Accumulate historical events as pagination loads more
  useEffect(() => {
    if (historicalEvents.length > 0) {
      setAllHistoricalEvents(prev => {
        // Deduplicate by event_id
        const seen = new Set(prev.map(e => e.envelope?.event_id).filter(Boolean));
        const newEvents = historicalEvents.filter(e => {
          const id = e.envelope?.event_id;
          return id && !seen.has(id);
        });
        return [...prev, ...newEvents];
      });
    }
  }, [historicalEvents]);

  // Merge live + historical events, deduplicate by event_id, sort newest first
  const mergedEvents = useMemo(() => {
    const seen = new Set<string>();
    const all: BloodbankEvent[] = [];

    // Live events take priority (they're newer)
    for (const ev of liveEvents) {
      const id = ev.envelope?.event_id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(ev);
    }

    // Then backfill with accumulated historical
    for (const ev of allHistoricalEvents) {
      const id = ev.envelope?.event_id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(ev);
    }

    return all;
  }, [liveEvents, allHistoricalEvents]);

  const summarized = useMemo(() => mergedEvents.map((event, idx) => deriveSummary(event, idx)), [mergedEvents]);

  // Memoized search index — compute searchable text once per event
  const searchIndex = useMemo(() => {
    const index = new Map<string, string>();
    summarized.forEach(event => {
      const searchText = [
        event.routingKey,
        event.agentName,
        event.action,
        JSON.stringify(event.payload),
      ].join(' ').toLowerCase();
      index.set(event.id, searchText);
    });
    return index;
  }, [summarized]);

  // Extract unique agents and event types for filter dropdowns
  const { availableAgents, availableEventTypes } = useMemo(() => {
    const agents = new Set<string>();
    const types = new Set<string>();
    
    summarized.forEach((event) => {
      if (event.agentName !== '—') {
        agents.add(event.agentName);
      }
      types.add(normalizeEventTypeForFilter(event.routingKey));
    });

    return {
      availableAgents: Array.from(agents).sort(),
      availableEventTypes: Array.from(types).sort((a, b) => eventTypeFilterLabel(a).localeCompare(eventTypeFilterLabel(b))),
    };
  }, [summarized]);

  // Filter events based on all criteria
  const filteredEvents = useMemo(() => {
    let result = summarized;

    // Search query — use pre-computed search index
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter((event) => {
        const searchText = searchIndex.get(event.id);
        return searchText ? searchText.includes(query) : false;
      });
    }

    // Agent filter
    if (agentFilter) {
      result = result.filter((event) => event.agentName === agentFilter);
    }

    // Event type filter
    if (eventTypeFilter) {
      result = result.filter((event) => normalizeEventTypeForFilter(event.routingKey) === eventTypeFilter);
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
  }, [summarized, searchQuery, agentFilter, eventTypeFilter, timeRangeFilter, searchIndex]);

  // Virtual scrolling setup
  const virtualizer = useVirtualizer({
    count: filteredEvents.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 48, // Estimated row height
    overscan: 10, // Render 10 extra rows above/below viewport
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Load more when scrolling near bottom
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current || !hasMore || historyLoading) return;
    
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const scrolledToBottom = scrollHeight - scrollTop - clientHeight < 200;
    
    if (scrolledToBottom) {
      setHistoricalOffset(prev => prev + 50);
    }
  }, [hasMore, historyLoading]);

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
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {!panelVisible || filteredEvents.length === 0 ? (
          <EmptyState panelVisible={panelVisible} loading={historyLoading} />
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualItems.map((virtualItem) => {
              const event = filteredEvents[virtualItem.index];
              if (!event) return null;
              return (
                <div
                  key={event.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <EventRow
                    event={event}
                    expanded={expanded.has(event.id)}
                    onToggle={() => toggleExpanded(event.id)}
                  />
                </div>
              );
            })}
            {historyLoading && hasMore && (
              <div className="flex items-center justify-center gap-2 py-4 text-xs text-slate-400">
                <span className="animate-pulse">Loading more events...</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status bar: always show event counts */}
      {panelVisible && (
        <div className="border-t border-slate-800 bg-slate-900/50 px-4 py-2 text-xs text-slate-400">
          {filteredEvents.length !== summarized.length
            ? `Showing ${filteredEvents.length} of ${summarized.length} events`
            : `${summarized.length} events`}
          {liveEvents.length > 0 && (
            <span className="ml-2 text-emerald-400">• {liveEvents.length} live</span>
          )}
          {allHistoricalEvents.length > 0 && (
            <span className="ml-2 text-blue-400">• {allHistoricalEvents.length} from history</span>
          )}
          {hasMore && !historyLoading && (
            <span className="ml-2 text-slate-500">• Scroll for more</span>
          )}
          {searchQuery && <span className="ml-2">• Search: &ldquo;{searchQuery}&rdquo;</span>}
          {agentFilter && <span className="ml-2">• Agent: {agentFilter}</span>}
          {eventTypeFilter && <span className="ml-2">• Type: {eventTypeFilterLabel(eventTypeFilter)}</span>}
          {timeRangeFilter && <span className="ml-2">• Time: {timeRangeFilter}</span>}
        </div>
      )}
    </div>
  );
};

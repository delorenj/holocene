import React, { useMemo, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  type Node,
  type Edge,
  type NodeTypes,
  MarkerType,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import AgentNode, { type AgentNodeData } from './AgentNode';
import { useBloodbankStream, type BloodbankEvent } from './useBloodbankStream';

// ---------------------------------------------------------------------------
// Agent metadata
// ---------------------------------------------------------------------------
type AgentMeta = {
  id: string;
  name: string;
  emoji: string;
  role: string;
};

const AGENTS: AgentMeta[] = [
  { id: 'cack', name: 'cack', emoji: '👹', role: 'Main · Sysops Gremlin' },
  { id: 'rererere', name: 'rererere', emoji: '🪼', role: 'Work · Purple Jellyfish' },
  { id: 'tonny', name: 'tonny', emoji: '🤡', role: 'Family · Tim & Eric' },
];

const AGENT_Y: Record<string, number> = { cack: 80, rererere: 260, tonny: 440 };

// ---------------------------------------------------------------------------
// Colour mapping for event types
// ---------------------------------------------------------------------------
function edgeColor(routingKey: string): string {
  if (routingKey.includes('message')) return '#3b82f6'; // blue
  if (routingKey.includes('tool')) return '#f59e0b'; // amber
  if (routingKey.includes('subagent')) return '#a855f7'; // purple
  if (routingKey.includes('heartbeat')) return '#22c55e80'; // green dim
  if (routingKey.includes('error')) return '#ef4444'; // red
  return '#64748b'; // slate default
}

function actionFromKey(routingKey: string): string {
  const parts = routingKey.split('.');
  return parts.length > 2 ? parts.slice(2).join('.') : routingKey;
}

function agentFromKey(routingKey: string): string | null {
  const match = routingKey.match(/^agent\.([^.]+)\./);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Custom node types registration
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes: NodeTypes = { agent: AgentNode as any };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export const AgentGraph: React.FC = () => {
  const { events, connected, clearEvents } = useBloodbankStream();
  const [flashEdges, setFlashEdges] = useState<Record<string, { color: string; label: string }>>({});
  const flashTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Track per-agent stats
  const agentStats = useMemo(() => {
    const stats: Record<string, { count: number; lastTime: string | null; isProcessing: boolean }> = {};
    for (const a of AGENTS) {
      stats[a.id] = { count: 0, lastTime: null, isProcessing: false };
    }
    // Walk events oldest-first to get final counts
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (!ev?.routing_key) continue;
      const agentId = agentFromKey(ev.routing_key);
      if (agentId && stats[agentId]) {
        const s = stats[agentId]!;
        s.count++;
        const ts = ev.envelope?.timestamp;
        if (ts) s.lastTime = ts;
      }
    }
    // Mark processing if last event was within 5s
    for (const a of AGENTS) {
      const s = stats[a.id]!;
      if (s.lastTime) {
        const age = Date.now() - new Date(s.lastTime).getTime();
        s.isProcessing = age < 5000;
      }
    }
    return stats;
  }, [events]);

  // Flash edges on new events
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];
    if (!latest?.routing_key) return;
    const agentId = agentFromKey(latest.routing_key);
    if (!agentId) return;

    const edgeId = `edge-${agentId}-bloodbank`;
    const color = edgeColor(latest.routing_key);
    const label = actionFromKey(latest.routing_key);

    setFlashEdges((prev) => ({ ...prev, [edgeId]: { color, label } }));

    if (flashTimers.current[edgeId]) clearTimeout(flashTimers.current[edgeId]);
    flashTimers.current[edgeId] = setTimeout(() => {
      setFlashEdges((prev) => {
        const next = { ...prev };
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete next[edgeId];
        return next;
      });
    }, 3000);
  }, [events]);

  // Build nodes
  const nodes: Node[] = useMemo(() => {
    const result: Node[] = AGENTS.map((a) => {
      const s = agentStats[a.id]!;
      const d: AgentNodeData = {
        label: a.name,
        emoji: a.emoji,
        role: a.role,
        eventCount: s.count,
        lastEventTime: s.lastTime ? new Date(s.lastTime).toLocaleTimeString() : null,
        isProcessing: s.isProcessing,
      };
      return {
        id: a.id,
        type: 'agent',
        position: { x: 80, y: AGENT_Y[a.id] ?? 200 },
        data: d,
        draggable: true,
      };
    });

    // Bloodbank hub node
    const latestTs = events[0]?.envelope?.timestamp ?? null;
    const bloodbankData: AgentNodeData = {
      label: 'Bloodbank',
      emoji: '🩸',
      role: 'Event Exchange',
      eventCount: events.length,
      lastEventTime: latestTs ? new Date(latestTs).toLocaleTimeString() : null,
      isProcessing: latestTs !== null && (Date.now() - new Date(latestTs).getTime()) < 5000,
      isCenter: true,
    };

    result.push({
      id: 'bloodbank',
      type: 'agent',
      position: { x: 450, y: 230 },
      data: bloodbankData,
      draggable: true,
    });

    return result;
  }, [agentStats, events]);

  // Build edges
  const edges: Edge[] = useMemo(() => {
    return AGENTS.map((a) => {
      const edgeId = `edge-${a.id}-bloodbank`;
      const flash = flashEdges[edgeId];
      const isActive = !!flash;

      return {
        id: edgeId,
        source: a.id,
        target: 'bloodbank',
        animated: isActive,
        style: {
          stroke: isActive ? flash.color : '#334155',
          strokeWidth: isActive ? 3 : 1.5,
          filter: isActive ? `drop-shadow(0 0 6px ${flash.color})` : undefined,
          transition: 'stroke 0.3s, stroke-width 0.3s',
        },
        label: isActive ? flash.label : undefined,
        labelStyle: {
          fill: isActive ? flash.color : '#64748b',
          fontSize: 11,
          fontWeight: 600,
        },
        labelBgStyle: {
          fill: '#0f172a',
          fillOpacity: 0.85,
        },
        labelBgPadding: [6, 3] as [number, number],
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isActive ? flash.color : '#334155',
          width: 16,
          height: 16,
        },
      };
    });
  }, [flashEdges]);

  const defaultViewport = { x: 50, y: 0, zoom: 0.95 };

  return (
    <div className="flex h-full flex-col bg-slate-950">
      {/* Connection indicator */}
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              connected ? 'animate-pulse bg-emerald-400' : 'bg-red-500'
            }`}
          />
          <span className="text-xs text-slate-400">
            {connected ? 'Connected to Bloodbank' : 'Disconnected — reconnecting…'}
          </span>
        </div>
        <button
          type="button"
          onClick={clearEvents}
          className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-800 hover:text-slate-300"
        >
          Clear log
        </button>
      </div>

      {/* Graph + Event log split */}
      <div className="flex flex-1 overflow-hidden">
        {/* Graph area */}
        <div className="flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            defaultViewport={defaultViewport}
            fitView={false}
            proOptions={{ hideAttribution: true }}
            minZoom={0.4}
            maxZoom={2}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable={false}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#1e293b" />
          </ReactFlow>
        </div>

        {/* Event stream panel */}
        <div className="flex w-80 flex-col border-l border-slate-800 bg-slate-950">
          <div className="border-b border-slate-800 px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Event Stream
            </h3>
          </div>
          <EventLog events={events} />
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Event log sub-component
// ---------------------------------------------------------------------------
const EventLog: React.FC<{ events: BloodbankEvent[] }> = ({ events }) => {
  const logRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={logRef} className="flex-1 overflow-y-auto px-2 py-1 font-mono text-[11px]">
      {events.length === 0 && (
        <div className="py-8 text-center text-xs text-slate-600">
          Waiting for events…
        </div>
      )}
      {events.slice(0, 50).map((ev, i) => {
        if (!ev.routing_key) return null;
        const ts = ev.envelope?.timestamp
          ? new Date(ev.envelope.timestamp).toLocaleTimeString()
          : '??:??:??';
        const color = edgeColor(ev.routing_key);
        const payload = ev.envelope?.payload ?? {};
        const detail =
          (payload['message_preview'] as string) ??
          (payload['tool_name'] as string) ??
          (payload['task_id'] as string) ??
          '';

        return (
          <div
            key={ev.envelope?.event_id ?? `evt-${i}`}
            className="border-b border-slate-800/50 py-1.5 leading-tight"
          >
            <span className="text-slate-600">[{ts}]</span>{' '}
            <span style={{ color }}>{ev.routing_key}</span>
            {detail && (
              <>
                {' '}
                <span className="text-slate-500">— {detail}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

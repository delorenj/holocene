import React, { useMemo, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  MarkerType,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import AgentNode, { type AgentNodeData, type AgentStatus } from './AgentNode';
import { useBloodbankStream, type BloodbankEvent } from '../../hooks/useBloodbankStream';
import { useAgentTickets, type AgentTicket } from '../../hooks/useAgentTickets';
import { useMismatchTelemetry } from '../../hooks/useMismatchTelemetry';

// ---------------------------------------------------------------------------
// Agent roster
// ---------------------------------------------------------------------------
type AgentMeta = {
  id: string;
  name: string;
  emoji: string;
  role: string;
  avatarDir: string;
  avatarFile: string;
};

const AGENTS: AgentMeta[] = [
  { id: 'cack',       name: 'Cack',         emoji: '👹', role: 'Main · Sysops Gremlin',   avatarDir: 'Cack',         avatarFile: 'themed.png' },
  { id: 'grolf',      name: 'Grolf',        emoji: '🪨', role: 'Eng · Director of Eng',   avatarDir: 'Grolf',        avatarFile: 'Grolf.png' },
  { id: 'rererere',   name: 'Rererere',     emoji: '🪼', role: 'Work · Purple Jellyfish', avatarDir: 'Rererere',     avatarFile: 'Rererere.png' },
  { id: 'lenoon',     name: 'Lenoon',       emoji: '🦎', role: 'Infra · Salamander',      avatarDir: 'Lenoon',       avatarFile: 'original.png' },
  { id: 'tonny',      name: 'Tonny',        emoji: '🤡', role: 'Family · Tim & Eric',     avatarDir: 'Tonny',        avatarFile: 'avatar.png' },
  { id: 'tongy',      name: 'Tongy',        emoji: '🐉', role: 'Family · Sidekick',       avatarDir: 'Tongy',        avatarFile: 'original.png' },
  { id: 'rar',        name: 'Rar',          emoji: '🦖', role: 'Work · Builder',           avatarDir: 'Rar',          avatarFile: 'Rar.png' },
  { id: 'pepe',       name: 'Pepe',         emoji: '🐸', role: 'Vibes · Cultural Attaché', avatarDir: 'Pepe',         avatarFile: 'original.png' },
  { id: 'lalathing',  name: 'LalaTheThing', emoji: '👾', role: 'Creative · Chaos Agent',  avatarDir: 'LalaTheThing', avatarFile: 'original.png' },
  { id: 'momothecat', name: 'MomoTheCat',   emoji: '🐱', role: 'QA · Feline Inspector',   avatarDir: 'MomoTheCat',   avatarFile: 'original.png' },
  { id: 'yi',         name: 'Yi',           emoji: '🧿', role: 'Mobile · Node Agent',     avatarDir: '',             avatarFile: '' },
];

function avatarUrl(agent: AgentMeta): string | null {
  if (!agent.avatarDir) return null;
  return `/avatars/${agent.avatarDir}/${agent.avatarFile}`;
}

// ---------------------------------------------------------------------------
// Radial layout
// ---------------------------------------------------------------------------
const CENTER = { x: 500, y: 400 };
const RADIUS = 320;

function radialPosition(index: number, total: number): { x: number; y: number } {
  const angle = (2 * Math.PI * index) / total - Math.PI / 2;
  return {
    x: CENTER.x + RADIUS * Math.cos(angle) - 80,
    y: CENTER.y + RADIUS * Math.sin(angle) - 50,
  };
}

// ---------------------------------------------------------------------------
// Edge colors + helpers
// ---------------------------------------------------------------------------
function edgeColor(routingKey: string): string {
  if (routingKey.includes('message')) return '#3b82f6';
  if (routingKey.includes('tool')) return '#f59e0b';
  if (routingKey.includes('subagent')) return '#a855f7';
  if (routingKey.includes('heartbeat')) return '#22c55e80';
  if (routingKey.includes('error')) return '#ef4444';
  if (routingKey.includes('asset')) return '#06b6d4';
  if (routingKey.includes('mismatch')) return '#f59e0b';
  return '#64748b';
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
// Status derivation — THE RULE: no "working" without a started Plane ticket
// ---------------------------------------------------------------------------
const RECENT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function deriveStatus(
  hasRecentEvent: boolean,
  ticket: AgentTicket | undefined,
): AgentStatus {
  const hasStartedTicket = !!ticket; // useAgentTickets only returns started tickets

  if (hasStartedTicket && hasRecentEvent) return 'working';
  if (hasStartedTicket && !hasRecentEvent) return 'idle'; // ticket but quiet
  if (!hasStartedTicket && hasRecentEvent) return 'rogue'; // active with no ticket!
  return 'idle';
}

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes: NodeTypes = { agent: AgentNode as any };

// ---------------------------------------------------------------------------
// Initial state builders
// ---------------------------------------------------------------------------
function buildInitialNodes(): Node[] {
  const agentNodes: Node[] = AGENTS.map((a, i) => ({
    id: a.id,
    type: 'agent',
    position: radialPosition(i, AGENTS.length),
    data: {
      label: a.name,
      emoji: a.emoji,
      role: a.role,
      avatarUrl: avatarUrl(a),
      status: 'idle' as AgentStatus,
      eventCount: 0,
      lastEventTime: null,
      isProcessing: false,
      ticketId: null,
      ticketTitle: null,
      ticketUrl: null,
    } satisfies AgentNodeData,
    draggable: true,
  }));

  agentNodes.push({
    id: 'bloodbank',
    type: 'agent',
    position: { x: CENTER.x - 80, y: CENTER.y - 50 },
    data: {
      label: 'Bloodbank',
      emoji: '🩸',
      role: 'Event Exchange',
      avatarUrl: null,
      status: 'idle' as AgentStatus,
      eventCount: 0,
      lastEventTime: null,
      isProcessing: false,
      ticketId: null,
      ticketTitle: null,
      ticketUrl: null,
      isCenter: true,
    } satisfies AgentNodeData,
    draggable: true,
  });

  return agentNodes;
}

function buildInitialEdges(): Edge[] {
  return AGENTS.map((a) => ({
    id: `edge-${a.id}-bloodbank`,
    source: a.id,
    target: 'bloodbank',
    animated: false,
    style: { stroke: '#334155', strokeWidth: 1.5, transition: 'stroke 0.3s, stroke-width 0.3s' },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#334155', width: 16, height: 16 },
  }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export const AgentGraph: React.FC = () => {
  const { events, connected, clearEvents } = useBloodbankStream();
  const { data: agentTickets } = useAgentTickets();
  const [flashEdges, setFlashEdges] = useState<Record<string, { color: string; label: string }>>({});
  const flashTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const [nodes, setNodes, onNodesChange] = useNodesState(buildInitialNodes());
  const [edges, setEdges, onEdgesChange] = useEdgesState(buildInitialEdges());

  // Per-agent event stats
  const agentStats = useMemo(() => {
    const stats: Record<string, { count: number; lastTime: string | null; isProcessing: boolean }> = {};
    for (const a of AGENTS) {
      stats[a.id] = { count: 0, lastTime: null, isProcessing: false };
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (!ev?.routing_key) continue;
      const agentId = agentFromKey(ev.routing_key);
      if (agentId && stats[agentId]) {
        stats[agentId].count++;
        const ts = ev.envelope?.timestamp;
        if (ts) stats[agentId].lastTime = ts;
      }
    }
    for (const a of AGENTS) {
      const s = stats[a.id];
      if (s?.lastTime) {
        s.isProcessing = Date.now() - new Date(s.lastTime).getTime() < 5000;
      }
    }
    return stats;
  }, [events]);

  // Detect mismatches — agents with recent events but no started ticket
  const mismatches = useMemo(() => {
    const list: Array<{ agentId: string; agentName: string; lastEventTime: string; eventCount: number }> = [];
    for (const a of AGENTS) {
      const s = agentStats[a.id];
      if (!s?.lastTime) continue;
      const hasRecentEvent = Date.now() - new Date(s.lastTime).getTime() < RECENT_THRESHOLD_MS;
      const hasTicket = !!agentTickets?.[a.id];
      if (hasRecentEvent && !hasTicket) {
        list.push({
          agentId: a.id,
          agentName: a.name,
          lastEventTime: s.lastTime,
          eventCount: s.count,
        });
      }
    }
    return list;
  }, [agentStats, agentTickets]);

  // Emit mismatch telemetry (debounced, best-effort)
  useMismatchTelemetry(mismatches);

  // Update node DATA without resetting dragged positions
  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        if (node.id === 'bloodbank') {
          const latestTs = events[0]?.envelope?.timestamp ?? null;
          return {
            ...node,
            data: {
              ...node.data,
              eventCount: events.length,
              lastEventTime: latestTs ? new Date(latestTs).toLocaleTimeString() : null,
              isProcessing: latestTs !== null && Date.now() - new Date(latestTs).getTime() < 5000,
            },
          };
        }

        const agent = AGENTS.find((a) => a.id === node.id);
        if (!agent) return node;

        const s = agentStats[agent.id] ?? { count: 0, lastTime: null, isProcessing: false };
        const ticket = agentTickets?.[agent.id];
        const hasRecentEvent = s.lastTime !== null && Date.now() - new Date(s.lastTime).getTime() < RECENT_THRESHOLD_MS;

        return {
          ...node,
          data: {
            ...node.data,
            status: deriveStatus(hasRecentEvent, ticket),
            eventCount: s.count,
            lastEventTime: s.lastTime ? new Date(s.lastTime).toLocaleTimeString() : null,
            isProcessing: s.isProcessing,
            ticketId: ticket?.ticketId ?? null,
            ticketTitle: ticket?.ticketTitle ?? null,
            ticketUrl: ticket?.ticketUrl ?? null,
          },
        };
      })
    );
  }, [agentStats, agentTickets, events, setNodes]);

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
        delete next[edgeId];
        return next;
      });
    }, 3000);
  }, [events]);

  // Update edge styles on flash
  useEffect(() => {
    setEdges((prev) =>
      prev.map((edge) => {
        const flash = flashEdges[edge.id];
        const isActive = !!flash;
        return {
          ...edge,
          animated: isActive,
          style: {
            stroke: isActive ? flash.color : '#334155',
            strokeWidth: isActive ? 3 : 1.5,
            filter: isActive ? `drop-shadow(0 0 6px ${flash.color})` : undefined,
            transition: 'stroke 0.3s, stroke-width 0.3s',
          },
          label: isActive ? flash.label : undefined,
          labelStyle: { fill: isActive ? flash.color : '#64748b', fontSize: 11, fontWeight: 600 },
          labelBgStyle: { fill: '#0f172a', fillOpacity: 0.85 },
          labelBgPadding: [6, 3] as [number, number],
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isActive ? flash.color : '#334155',
            width: 16,
            height: 16,
          },
        };
      })
    );
  }, [flashEdges, setEdges]);

  const mismatchCount = mismatches.length;

  return (
    <div className="flex h-full flex-col bg-slate-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${connected ? 'animate-pulse bg-emerald-400' : 'bg-red-500'}`} />
          <span className="text-xs text-slate-400">
            {connected ? 'Connected to Bloodbank' : 'Disconnected — reconnecting…'}
          </span>
          {agentTickets && (
            <span className="text-xs text-slate-600">
              · {Object.keys(agentTickets).length} agents with tickets
            </span>
          )}
          {mismatchCount > 0 && (
            <span className="rounded bg-amber-900/60 px-2 py-0.5 text-[10px] font-bold text-amber-400">
              ⚠ {mismatchCount} rogue agent{mismatchCount !== 1 ? 's' : ''}
            </span>
          )}
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
        <div className="flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            minZoom={0.3}
            maxZoom={2}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#1e293b" />
          </ReactFlow>
        </div>

        {/* Event stream panel */}
        <div className="flex w-80 flex-col border-l border-slate-800 bg-slate-950">
          <div className="border-b border-slate-800 px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Event Stream</h3>
          </div>
          <EventLog events={events} />
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------
const EventLog: React.FC<{ events: BloodbankEvent[] }> = ({ events }) => {
  const logRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={logRef} className="flex-1 overflow-y-auto px-2 py-1 font-mono text-[11px]">
      {events.length === 0 && (
        <div className="py-8 text-center text-xs text-slate-600">Waiting for events…</div>
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

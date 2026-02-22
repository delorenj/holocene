import React, { memo, useState } from 'react';
import { Handle, Position } from '@xyflow/react';

export type AgentStatus = 'working' | 'idle' | 'blocked' | 'offline';

export type AgentNodeData = {
  label: string;
  emoji: string;
  role: string;
  avatarUrl: string | null;
  status: AgentStatus;
  eventCount: number;
  lastEventTime: string | null;
  isProcessing: boolean;
  ticketId: string | null;
  ticketTitle: string | null;
  isCenter?: boolean;
  [key: string]: unknown;
};

const statusColor: Record<AgentStatus, string> = {
  working: 'bg-emerald-400',
  idle: 'bg-slate-500',
  blocked: 'bg-rose-500',
  offline: 'bg-slate-700',
};

const statusRing: Record<AgentStatus, string> = {
  working: 'ring-2 ring-emerald-400/60 ring-offset-1 ring-offset-slate-950',
  idle: '',
  blocked: 'ring-2 ring-rose-400/40 ring-offset-1 ring-offset-slate-950',
  offline: 'opacity-60',
};

type Props = { data: AgentNodeData };

const AgentNode: React.FC<Props> = ({ data: d }) => {
  const isCenter = d.isCenter ?? false;
  const [imgError, setImgError] = useState(false);

  return (
    <div
      className={`
        relative flex flex-col items-center rounded-2xl border px-5 py-4
        shadow-lg backdrop-blur-sm transition-all duration-300
        ${isCenter
          ? 'border-red-500/40 bg-red-950/60 shadow-red-500/20'
          : `border-slate-600/50 bg-slate-900/80 shadow-slate-500/10 hover:border-slate-500/70 ${statusRing[d.status]}`
        }
      `}
    >
      {/* Handles */}
      {!isCenter && (
        <Handle type="target" position={Position.Left}
          className="!h-2.5 !w-2.5 !border-2 !border-slate-600 !bg-slate-400" />
      )}
      <Handle type="source" position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-slate-600 !bg-slate-400" />
      {isCenter && (
        <>
          <Handle type="target" position={Position.Left}
            className="!h-2.5 !w-2.5 !border-2 !border-red-600 !bg-red-400" />
          <Handle type="target" position={Position.Top} id="top"
            className="!h-2.5 !w-2.5 !border-2 !border-red-600 !bg-red-400" />
          <Handle type="target" position={Position.Bottom} id="bottom"
            className="!h-2.5 !w-2.5 !border-2 !border-red-600 !bg-red-400" />
        </>
      )}

      {/* Avatar */}
      <div className={`mb-2 ${d.isProcessing ? 'animate-bounce' : ''}`}>
        {d.avatarUrl && !imgError ? (
          <img
            src={d.avatarUrl}
            alt={d.label}
            className="h-12 w-12 rounded-full border-2 border-slate-700 object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <span className="text-4xl">{d.emoji}</span>
        )}
      </div>

      {/* Name */}
      <div className={`text-lg font-bold tracking-wide ${isCenter ? 'text-red-300' : 'text-slate-100'}`}>
        {d.label}
      </div>

      {/* Role */}
      <div className="text-xs text-slate-400">{d.role}</div>

      {/* Status badge */}
      {!isCenter && (
        <div className="mt-2 flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${d.isProcessing ? 'animate-pulse ' : ''}${statusColor[d.status]}`} />
          <span className="text-[10px] font-medium text-slate-400">{d.status}</span>
          <span className="text-[10px] text-slate-600">
            {d.eventCount} evt{d.eventCount !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* Ticket (if working) */}
      {d.ticketId && (
        <div className="mt-1 max-w-[160px] truncate text-[10px] text-emerald-400" title={d.ticketTitle ?? ''}>
          🎫 {d.ticketId}{d.ticketTitle ? `: ${d.ticketTitle}` : ''}
        </div>
      )}

      {/* Last event time */}
      {d.lastEventTime && (
        <div className="mt-1 text-[10px] text-slate-500">{d.lastEventTime}</div>
      )}
    </div>
  );
};

export default memo(AgentNode);

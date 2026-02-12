import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

export type AgentNodeData = {
  label: string;
  emoji: string;
  role: string;
  eventCount: number;
  lastEventTime: string | null;
  isProcessing: boolean;
  isCenter?: boolean;
  [key: string]: unknown;
};

type Props = {
  data: AgentNodeData;
};

const AgentNode: React.FC<Props> = ({ data: d }) => {
  const isCenter = d.isCenter ?? false;

  return (
    <div
      className={`
        relative flex flex-col items-center rounded-2xl border px-5 py-4
        shadow-lg backdrop-blur-sm transition-all duration-300
        ${isCenter
          ? 'border-red-500/40 bg-red-950/60 shadow-red-500/20'
          : 'border-slate-600/50 bg-slate-900/80 shadow-slate-500/10 hover:border-slate-500/70'
        }
        ${d.isProcessing ? 'ring-2 ring-emerald-400/60 ring-offset-1 ring-offset-slate-950' : ''}
      `}
    >
      {/* Handles */}
      {!isCenter && (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-2.5 !w-2.5 !border-2 !border-slate-600 !bg-slate-400"
        />
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-slate-600 !bg-slate-400"
      />
      {isCenter && (
        <>
          <Handle
            type="target"
            position={Position.Left}
            className="!h-2.5 !w-2.5 !border-2 !border-red-600 !bg-red-400"
          />
          <Handle
            type="target"
            position={Position.Top}
            id="top"
            className="!h-2.5 !w-2.5 !border-2 !border-red-600 !bg-red-400"
          />
          <Handle
            type="target"
            position={Position.Bottom}
            id="bottom"
            className="!h-2.5 !w-2.5 !border-2 !border-red-600 !bg-red-400"
          />
        </>
      )}

      {/* Avatar */}
      <div className={`mb-2 text-4xl ${d.isProcessing ? 'animate-bounce' : ''}`}>
        {d.emoji}
      </div>

      {/* Name */}
      <div className={`text-lg font-bold tracking-wide ${isCenter ? 'text-red-300' : 'text-slate-100'}`}>
        {d.label}
      </div>

      {/* Role */}
      <div className="text-xs text-slate-400">{d.role}</div>

      {/* Status indicator */}
      <div className="mt-2 flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            d.isProcessing
              ? 'animate-pulse bg-emerald-400'
              : d.eventCount > 0
                ? 'bg-emerald-500'
                : 'bg-slate-600'
          }`}
        />
        <span className="text-[10px] text-slate-500">
          {d.eventCount} event{d.eventCount !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Last event time */}
      {d.lastEventTime && (
        <div className="mt-1 text-[10px] text-slate-500">
          {d.lastEventTime}
        </div>
      )}
    </div>
  );
};

export default memo(AgentNode);

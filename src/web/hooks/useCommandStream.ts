/**
 * useCommandStream — Derived hook that extracts command lifecycle events
 * from the Bloodbank WebSocket stream + Candystore history.
 *
 * Command routing keys follow the pattern:
 *   command.{agent}.{action}          → envelope (new command)
 *   command.{agent}.{action}.ack      → acknowledgement
 *   command.{agent}.{action}.result   → completion
 *   command.{agent}.{action}.error    → failure
 *
 * Each command is correlated by payload.command_id and tracked through
 * its lifecycle: dispatched → acked → completed|failed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBloodbankStream, type BloodbankEvent } from './useBloodbankStream';
import { useEventHistory } from './useEventHistory';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandPhase = 'dispatched' | 'acked' | 'working' | 'completed' | 'failed' | 'expired';

export type CommandRecord = {
  commandId: string;
  targetAgent: string;
  action: string;
  issuedBy: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  phase: CommandPhase;
  dispatchedAt: string;          // ISO timestamp
  ackedAt: string | null;
  completedAt: string | null;    // result or error timestamp
  ackLatencyMs: number | null;
  totalDurationMs: number | null;
  outcome: 'success' | 'partial' | 'skipped' | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  fsmVersion: number | null;
  ttlMs: number;
  idempotencyKey: string | null;
};

export type AgentCommandStats = {
  agent: string;
  total: number;
  acked: number;
  completed: number;
  failed: number;
  pending: number;
  avgAckLatencyMs: number | null;
  avgDurationMs: number | null;
  successRate: number | null;      // 0–1
  errorCodes: Record<string, number>;
  lastCommandAt: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRoutingKey(rk: string): { agent: string; action: string; suffix: 'envelope' | 'ack' | 'result' | 'error' } | null {
  if (!rk.startsWith('command.')) return null;

  const parts = rk.split('.');
  // command.{agent}.{action}          → 3 parts → envelope
  // command.{agent}.{action}.{suffix} → 4 parts → ack|result|error
  if (parts.length === 3) {
    return { agent: parts[1]!, action: parts[2]!, suffix: 'envelope' };
  }
  if (parts.length === 4) {
    const suffix = parts[3] as 'ack' | 'result' | 'error';
    if (['ack', 'result', 'error'].includes(suffix)) {
      return { agent: parts[1]!, action: parts[2]!, suffix };
    }
  }
  return null;
}

function phaseFromSuffix(suffix: 'envelope' | 'ack' | 'result' | 'error'): CommandPhase {
  switch (suffix) {
    case 'envelope': return 'dispatched';
    case 'ack': return 'acked';
    case 'result': return 'completed';
    case 'error': return 'failed';
  }
}

function msElapsed(from: string, to: string): number {
  return new Date(to).getTime() - new Date(from).getTime();
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCommandStream() {
  const { events: liveEvents, connected } = useBloodbankStream();
  const { events: historyEvents, loading: historyLoading } = useEventHistory({
    limit: 200,
    eventType: 'command.',
  });

  // Store command records keyed by commandId
  const commandsRef = useRef<Map<string, CommandRecord>>(new Map());
  const [commands, setCommands] = useState<CommandRecord[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  // Process a single BloodbankEvent into the command map
  const processEvent = useCallback((ev: BloodbankEvent): boolean => {
    if (ev.type !== 'event' || !ev.routing_key || !ev.envelope) return false;

    const parsed = parseRoutingKey(ev.routing_key);
    if (!parsed) return false;

    const payload = ev.envelope.payload as Record<string, unknown>;
    const commandId = (payload.command_id as string) ?? ev.envelope.event_id;
    if (!commandId) return false;

    // Dedup: event_id + suffix
    const dedupKey = `${ev.envelope.event_id}:${parsed.suffix}`;
    if (seenRef.current.has(dedupKey)) return false;
    seenRef.current.add(dedupKey);

    const map = commandsRef.current;
    const existing = map.get(commandId);

    if (parsed.suffix === 'envelope') {
      if (existing) return false; // duplicate envelope
      const rec: CommandRecord = {
        commandId,
        targetAgent: (payload.target_agent as string) ?? parsed.agent,
        action: (payload.action as string) ?? parsed.action,
        issuedBy: (payload.issued_by as string) ?? 'unknown',
        priority: (payload.priority as CommandRecord['priority']) ?? 'normal',
        phase: 'dispatched',
        dispatchedAt: ev.envelope.timestamp,
        ackedAt: null,
        completedAt: null,
        ackLatencyMs: null,
        totalDurationMs: null,
        outcome: null,
        errorCode: null,
        errorMessage: null,
        retryable: false,
        fsmVersion: null,
        ttlMs: (payload.ttl_ms as number) ?? 30000,
        idempotencyKey: (payload.idempotency_key as string) ?? null,
      };
      map.set(commandId, rec);
      return true;
    }

    // For ack/result/error: need existing record or create stub
    const rec = existing ?? {
      commandId,
      targetAgent: (payload.target_agent as string) ?? parsed.agent,
      action: (payload.action as string) ?? parsed.action,
      issuedBy: 'unknown',
      priority: 'normal' as const,
      phase: 'dispatched' as CommandPhase,
      dispatchedAt: ev.envelope.timestamp, // approximate
      ackedAt: null,
      completedAt: null,
      ackLatencyMs: null,
      totalDurationMs: null,
      outcome: null,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      fsmVersion: null,
      ttlMs: 30000,
      idempotencyKey: null,
    };

    if (parsed.suffix === 'ack') {
      rec.phase = 'acked';
      rec.ackedAt = ev.envelope.timestamp;
      rec.fsmVersion = (payload.fsm_version as number) ?? null;
      if (rec.dispatchedAt) {
        rec.ackLatencyMs = msElapsed(rec.dispatchedAt, ev.envelope.timestamp);
      }
    } else if (parsed.suffix === 'result') {
      rec.phase = 'completed';
      rec.completedAt = ev.envelope.timestamp;
      rec.outcome = (payload.outcome as CommandRecord['outcome']) ?? 'success';
      rec.fsmVersion = (payload.fsm_version as number) ?? null;
      if (rec.dispatchedAt) {
        rec.totalDurationMs = msElapsed(rec.dispatchedAt, ev.envelope.timestamp);
      }
    } else if (parsed.suffix === 'error') {
      rec.phase = 'failed';
      rec.completedAt = ev.envelope.timestamp;
      rec.errorCode = (payload.error_code as string) ?? null;
      rec.errorMessage = (payload.error_message as string) ?? null;
      rec.retryable = (payload.retryable as boolean) ?? false;
      rec.fsmVersion = (payload.fsm_version as number) ?? null;
      if (rec.dispatchedAt) {
        rec.totalDurationMs = msElapsed(rec.dispatchedAt, ev.envelope.timestamp);
      }
    }

    map.set(commandId, rec);
    return true;
  }, []);

  // Process historical events on load
  useEffect(() => {
    if (historyLoading) return;
    let changed = false;
    for (const ev of [...historyEvents].reverse()) {
      if (processEvent(ev)) changed = true;
    }
    if (changed) {
      setCommands(Array.from(commandsRef.current.values()));
    }
  }, [historyEvents, historyLoading, processEvent]);

  // Process live events
  useEffect(() => {
    let changed = false;
    for (const ev of liveEvents) {
      if (processEvent(ev)) changed = true;
    }
    if (changed) {
      setCommands(Array.from(commandsRef.current.values()));
    }
  }, [liveEvents, processEvent]);

  // Compute per-agent stats
  const agentStats = useMemo<AgentCommandStats[]>(() => {
    const agentMap = new Map<string, CommandRecord[]>();
    for (const cmd of commands) {
      const list = agentMap.get(cmd.targetAgent) ?? [];
      list.push(cmd);
      agentMap.set(cmd.targetAgent, list);
    }

    return Array.from(agentMap.entries()).map(([agent, cmds]) => {
      const acked = cmds.filter(c => c.ackedAt != null).length;
      const completed = cmds.filter(c => c.phase === 'completed').length;
      const failed = cmds.filter(c => c.phase === 'failed').length;
      const pending = cmds.filter(c => c.phase === 'dispatched' || c.phase === 'acked').length;
      const finished = completed + failed;

      const ackLatencies = cmds
        .map(c => c.ackLatencyMs)
        .filter((v): v is number => v != null);
      const durations = cmds
        .map(c => c.totalDurationMs)
        .filter((v): v is number => v != null);

      const errorCodes: Record<string, number> = {};
      for (const c of cmds) {
        if (c.errorCode) {
          errorCodes[c.errorCode] = (errorCodes[c.errorCode] ?? 0) + 1;
        }
      }

      const lastCmd = cmds.reduce<string | null>((latest, c) => {
        const t = c.completedAt ?? c.ackedAt ?? c.dispatchedAt;
        if (!latest || t > latest) return t;
        return latest;
      }, null);

      return {
        agent,
        total: cmds.length,
        acked,
        completed,
        failed,
        pending,
        avgAckLatencyMs: ackLatencies.length > 0
          ? Math.round(ackLatencies.reduce((a, b) => a + b, 0) / ackLatencies.length)
          : null,
        avgDurationMs: durations.length > 0
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : null,
        successRate: finished > 0 ? completed / finished : null,
        errorCodes,
        lastCommandAt: lastCmd,
      };
    }).sort((a, b) => b.total - a.total);
  }, [commands]);

  return {
    commands,
    agentStats,
    connected,
    historyLoading,
    totalCommands: commands.length,
  };
}

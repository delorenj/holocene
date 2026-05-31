import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useHolyfieldsSchemas, type JsonSchema } from '../../hooks/useHolyfieldsSchemas';
import { useBloodbankStream } from '../../hooks/useBloodbankStream';
import { useEventHistory } from '../../hooks/useEventHistory';

type JsonPrimitive = string | number | boolean | null;
type JsonObject = { [key: string]: Value };
type JsonArray = Value[];
type Value = JsonPrimitive | JsonObject | JsonArray;

type JourneyStage = 'idle' | 'pending' | 'success' | 'error';

type JourneyState = {
  runAt: string;
  eventId: string | null;
  commandId: string | null;
  eventType: string;
  creatingEvent: JourneyStage;
  eventCreated: JourneyStage;
  postingRabbit: JourneyStage;
  inQueue: JourneyStage;
  consumed: JourneyStage;
  queueStartedAt: string | null;
  queueElapsedSec: number;
  timeoutSeconds: number;
  consumedBy: string | null;
  note?: string;
};

const BLOODBANK_PUBLISH_URL = import.meta.env.VITE_BLOODBANK_PUBLISH_URL ?? '/api/bloodbank/events/custom';
const QUEUE_TIMEOUT_SECONDS = (() => {
  const parsed = Number.parseInt(import.meta.env.VITE_BLOODBANK_QUEUE_TIMEOUT_SECONDS ?? '30', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
})();

const VETTED_SCHEMA_PATHS = new Set<string>([
  'agent/heartbeat.v1.json',
  'agent/thread/prompt.v1.json',
  'agent/thread/response.v1.json',
  'agent/thread/error.v1.json',
  'agent/message.sent.v1.json',
  'agent/message.received.v1.json',
  'session/thread/start.v1.json',
  'session/thread/message.v1.json',
  'session/thread/end.v1.json',
  'session/thread/error.v1.json',
  'session/thread/agent/action.v1.json',
  'session/thread/agent/thinking.v1.json',
  'fireflies/transcript/upload.v1.json',
  'fireflies/transcript/ready.v1.json',
  'fireflies/transcript/processed.v1.json',
  'fireflies/transcript/failed.v1.json',
  'artifact/audio/detected.v1.json',
]);

function isVettedSchema(schemaPath: string): boolean {
  if (schemaPath.startsWith('command/')) return true;
  return VETTED_SCHEMA_PATHS.has(schemaPath);
}

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function primaryType(schema: JsonSchema | undefined): string | undefined {
  if (!schema) return undefined;
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    return schema.type.find((t) => t !== 'null') ?? schema.type[0];
  }
  return undefined;
}

function setAtPath(root: Value, path: string[], next: Value): Value {
  if (path.length === 0) return next;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return root;

  const [head, ...tail] = path;
  const clone: Record<string, Value> = { ...(root as Record<string, Value>) };
  if (!head) return clone;

  if (tail.length === 0) {
    clone[head] = next;
    return clone;
  }

  const currentChild = clone[head];
  const safeChild =
    currentChild && typeof currentChild === 'object' && !Array.isArray(currentChild)
      ? currentChild
      : {};

  clone[head] = setAtPath(safeChild as Value, tail, next);
  return clone;
}

function pickDefaultString(propName: string, schema: JsonSchema): string {
  if (typeof schema.const === 'string') return schema.const;
  if (typeof schema.default === 'string') return schema.default;

  const enumValues = Array.isArray(schema.enum) ? schema.enum.filter((v): v is string => typeof v === 'string') : [];
  if (enumValues.length > 0) return enumValues[0] ?? '';

  if (schema.format === 'date-time') return nowIso();
  if (schema.format === 'uuid' || propName === 'event_id' || propName.endsWith('_id')) return uuid();

  if (propName === 'version') return '1.0.0';
  if (propName === 'event_type') return 'custom.event';
  if (propName === 'host') return 'holocene';
  if (propName === 'app') return 'holocene-test-board';
  if (propName === 'trigger_type') return 'api';
  if (propName === 'type') return 'manual';

  if (schema.minLength && schema.minLength > 0) {
    return 'x'.repeat(Math.min(schema.minLength, 16));
  }

  return '';
}

function buildDefaultValue(schema: JsonSchema, propName = ''): Value {
  if (schema.const !== undefined) return schema.const as Value;
  if (schema.default !== undefined) return schema.default as Value;

  const pType = primaryType(schema);

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return (schema.enum[0] ?? null) as Value;
  }

  if (pType === 'object' || (!pType && schema.properties)) {
    const output: Record<string, Value> = {};
    const required = new Set(schema.required ?? []);

    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const shouldInclude =
        required.has(key) ||
        child.const !== undefined ||
        child.default !== undefined ||
        key === 'event_type' ||
        key === 'version';

      if (!shouldInclude) continue;
      output[key] = buildDefaultValue(child, key);
    }

    return output;
  }

  if (pType === 'array') {
    const minItems = typeof schema.minItems === 'number' ? schema.minItems : 0;
    if (schema.items && minItems > 0) {
      return Array.from({ length: minItems }, () => buildDefaultValue(schema.items as JsonSchema));
    }
    return [];
  }

  if (pType === 'boolean') return false;

  if (pType === 'integer' || pType === 'number') {
    if (typeof schema.minimum === 'number') return schema.minimum;
    return 0;
  }

  return pickDefaultString(propName, schema);
}

function ensureRuntimeEnvelopeCompatibility(value: Value, fallbackEventType: string): Value {
  const root = asObject(value) as Record<string, Value>;

  if (typeof root.event_id !== 'string' || !root.event_id) {
    root.event_id = uuid();
  }

  if (typeof root.event_type !== 'string' || !root.event_type) {
    root.event_type = fallbackEventType;
  }

  if (typeof root.timestamp !== 'string' || !root.timestamp) {
    root.timestamp = nowIso();
  }

  if (typeof root.version !== 'string' || !root.version) {
    root.version = '1.0.0';
  }

  if (!Array.isArray(root.correlation_ids)) {
    root.correlation_ids = [];
  }

  const source = asObject(root.source) as Record<string, Value>;
  if (!source.host) source.host = 'holocene';
  if (!source.app) source.app = 'holocene-test-board';
  if (!source.type) source.type = 'manual';
  if (!source.trigger_type) source.trigger_type = 'api';
  root.source = source;

  return root;
}

function coerceValue(input: string, schema: JsonSchema): Value {
  const pType = primaryType(schema);

  if (pType === 'integer') {
    const parsed = Number.parseInt(input, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (pType === 'number') {
    const parsed = Number.parseFloat(input);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (pType === 'array' || pType === 'object') {
    try {
      const parsed = JSON.parse(input);
      return parsed as Value;
    } catch {
      return pType === 'array' ? [] : {};
    }
  }

  if (input === '' && Array.isArray(schema.type) && schema.type.includes('null')) {
    return null;
  }

  return input;
}

const Led: React.FC<{ label: string; state: JourneyStage; step: number }> = ({ label, state, step }) => {
  const color =
    state === 'success'
      ? 'bg-emerald-400 shadow-emerald-500/60'
      : state === 'error'
        ? 'bg-red-400 shadow-red-500/60'
        : state === 'pending'
          ? 'bg-amber-400 shadow-amber-500/60'
          : 'bg-slate-600 shadow-slate-700/40';

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${color} shadow`} />
      <span className="text-slate-500">{step}.</span>
      <span>{label}</span>
    </div>
  );
};

const JourneyTrack: React.FC<{ journey?: JourneyState }> = ({ journey }) => {
  const inQueueLabel =
    journey?.inQueue === 'pending'
      ? `In Queue (${journey.queueElapsedSec}s)`
      : 'In Queue';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Led label="Creating Event" step={1} state={journey?.creatingEvent ?? 'idle'} />
      <span className="text-slate-600">→</span>
      <Led label="Event Created" step={2} state={journey?.eventCreated ?? 'idle'} />
      <span className="text-slate-600">→</span>
      <Led label="Posting to RabbitMQ" step={3} state={journey?.postingRabbit ?? 'idle'} />
      <span className="text-slate-600">→</span>
      <Led label={inQueueLabel} step={4} state={journey?.inQueue ?? 'idle'} />
      <span className="text-slate-600">→</span>
      <Led label="Consumed / Timed Out" step={5} state={journey?.consumed ?? 'idle'} />
    </div>
  );
};

type FieldEditorProps = {
  label: string;
  schema: JsonSchema;
  value: Value | undefined;
  required: boolean;
  path: string[];
  onChange: (path: string[], next: Value) => void;
};

const FieldEditor: React.FC<FieldEditorProps> = ({ label, schema, value, required, path, onChange }) => {
  const pType = primaryType(schema);
  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];

  if ((pType === 'object' || (!pType && schema.properties)) && schema.properties) {
    const requiredSet = new Set(schema.required ?? []);

    return (
      <div className="rounded border border-slate-800 bg-slate-900/40 p-3">
        <div className="mb-2 text-xs font-semibold text-slate-300">
          {label} {required ? <span className="text-red-400">*</span> : null}
        </div>
        <div className="grid gap-3">
          {Object.entries(schema.properties).map(([key, child]) => (
            <FieldEditor
              key={key}
              label={key}
              schema={child}
              value={
                value && typeof value === 'object' && !Array.isArray(value)
                  ? (value as Record<string, Value>)[key]
                  : undefined
              }
              required={requiredSet.has(key)}
              path={[...path, key]}
              onChange={onChange}
            />
          ))}
        </div>
      </div>
    );
  }

  if (pType === 'array') {
    const jsonValue = JSON.stringify(value ?? [], null, 2);
    return (
      <label className="block text-xs text-slate-300">
        <div className="mb-1">
          {label} {required ? <span className="text-red-400">*</span> : null}
        </div>
        <textarea
          className="h-24 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200"
          value={jsonValue}
          onChange={(e) => onChange(path, coerceValue(e.target.value, schema))}
        />
      </label>
    );
  }

  if (enumValues.length > 0) {
    const selected = value ?? enumValues[0] ?? '';
    return (
      <label className="block text-xs text-slate-300">
        <div className="mb-1">
          {label} {required ? <span className="text-red-400">*</span> : null}
        </div>
        <select
          className="h-8 w-full rounded border border-slate-800 bg-slate-950 px-2 text-xs text-slate-200"
          value={String(selected)}
          onChange={(e) => onChange(path, coerceValue(e.target.value, schema))}
        >
          {enumValues.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (pType === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(path, e.target.checked)}
        />
        <span>
          {label} {required ? <span className="text-red-400">*</span> : null}
        </span>
      </label>
    );
  }

  if (pType === 'object') {
    const jsonValue = JSON.stringify(value ?? {}, null, 2);
    return (
      <label className="block text-xs text-slate-300">
        <div className="mb-1">
          {label} {required ? <span className="text-red-400">*</span> : null}
        </div>
        <textarea
          className="h-24 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200"
          value={jsonValue}
          onChange={(e) => onChange(path, coerceValue(e.target.value, schema))}
        />
      </label>
    );
  }

  const textValue = value == null ? '' : String(value);
  const inputType = pType === 'integer' || pType === 'number' ? 'number' : 'text';

  return (
    <label className="block text-xs text-slate-300">
      <div className="mb-1">
        {label} {required ? <span className="text-red-400">*</span> : null}
      </div>
      <input
        type={inputType}
        className="h-8 w-full rounded border border-slate-800 bg-slate-950 px-2 text-xs text-slate-200"
        value={textValue}
        onChange={(e) => onChange(path, coerceValue(e.target.value, schema))}
      />
    </label>
  );
};

export const BloodbankTestBoard: React.FC = () => {
  const { schemas, schemaCount } = useHolyfieldsSchemas();
  const { events: liveEvents, connected } = useBloodbankStream();
  const { events: historyEvents, loading: historyLoading } = useEventHistory({ limit: 500 });

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, Value>>({});
  const [journeys, setJourneys] = useState<Record<string, JourneyState>>({});
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'command' | 'event'>('all');
  const [catalogMode, setCatalogMode] = useState<'vetted' | 'all'>('vetted');

  const filteredSchemas = useMemo(() => {
    const q = query.trim().toLowerCase();

    return schemas.filter((schema) => {
      if (catalogMode === 'vetted' && !isVettedSchema(schema.schemaPath)) return false;
      if (kindFilter !== 'all' && schema.kind !== kindFilter) return false;
      if (!q) return true;

      return (
        schema.title.toLowerCase().includes(q) ||
        schema.eventType.toLowerCase().includes(q) ||
        schema.schemaPath.toLowerCase().includes(q)
      );
    });
  }, [schemas, query, kindFilter, catalogMode]);

  const ensureDraft = useCallback((schemaId: string, schema: JsonSchema, eventType: string) => {
    setDrafts((prev) => {
      if (prev[schemaId]) return prev;
      const generated = ensureRuntimeEnvelopeCompatibility(buildDefaultValue(schema), eventType);
      return {
        ...prev,
        [schemaId]: generated,
      };
    });
  }, []);

  const toggleExpanded = useCallback((schemaId: string, schema: JsonSchema, eventType: string) => {
    ensureDraft(schemaId, schema, eventType);
    setExpanded((prev) => ({ ...prev, [schemaId]: !prev[schemaId] }));
  }, [ensureDraft]);

  const updateDraft = useCallback((schemaId: string, path: string[], next: Value) => {
    setDrafts((prev) => {
      const current = prev[schemaId];
      if (!current) return prev;
      return {
        ...prev,
        [schemaId]: setAtPath(current, path, next),
      };
    });
  }, []);

  const fireSchema = useCallback(async (schemaId: string, schema: JsonSchema, eventType: string, useCurrentDraft: boolean) => {
    const source = useCurrentDraft ? drafts[schemaId] : undefined;
    const baseDraft = source ?? ensureRuntimeEnvelopeCompatibility(buildDefaultValue(schema), eventType);
    const envelope = ensureRuntimeEnvelopeCompatibility(baseDraft, eventType) as Record<string, Value>;

    if (eventType === 'command.envelope') {
      const payload = asObject(envelope.payload);
      const targetAgent = typeof payload.target_agent === 'string' && payload.target_agent ? payload.target_agent : 'lenoon';
      const action = typeof payload.action === 'string' && payload.action ? payload.action : 'run_drift_check';
      const commandId = typeof payload.command_id === 'string' && payload.command_id ? payload.command_id : uuid();
      payload.command_id = commandId;
      envelope.payload = payload as Value;
      envelope.event_type = `command.${targetAgent}.${action}`;
    }

    const eventId = typeof envelope.event_id === 'string' ? envelope.event_id : uuid();
    envelope.event_id = eventId;

    const commandId = (() => {
      const payload = asObject(envelope.payload);
      return typeof payload.command_id === 'string' ? payload.command_id : null;
    })();

    setDrafts((prev) => ({ ...prev, [schemaId]: envelope }));
    setJourneys((prev) => ({
      ...prev,
      [schemaId]: {
        runAt: nowIso(),
        eventId,
        commandId,
        eventType: String(envelope.event_type ?? eventType),
        creatingEvent: 'success',
        eventCreated: 'success',
        postingRabbit: 'pending',
        inQueue: 'idle',
        consumed: 'idle',
        queueStartedAt: null,
        queueElapsedSec: 0,
        timeoutSeconds: QUEUE_TIMEOUT_SECONDS,
        consumedBy: null,
        note: 'Event envelope created',
      },
    }));

    try {
      const res = await fetch(BLOODBANK_PUBLISH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      setJourneys((prev) => {
        const existing = prev[schemaId];
        if (!existing) return prev;

        return {
          ...prev,
          [schemaId]: {
            ...existing,
            postingRabbit: 'success',
            inQueue: 'pending',
            queueStartedAt: nowIso(),
            queueElapsedSec: 0,
            note: 'Posted to RabbitMQ, waiting for consumer',
          },
        };
      });
    } catch (error) {
      setJourneys((prev) => {
        const existing = prev[schemaId];
        if (!existing) return prev;

        return {
          ...prev,
          [schemaId]: {
            ...existing,
            postingRabbit: 'error',
            inQueue: 'error',
            consumed: 'error',
            note: error instanceof Error ? error.message : String(error),
          },
        };
      });
    }
  }, [drafts]);

  useEffect(() => {
    setJourneys((prev) => {
      if (Object.keys(prev).length === 0) return prev;

      let changed = false;
      const next: Record<string, JourneyState> = { ...prev };

      for (const [schemaId, journey] of Object.entries(prev)) {
        let updated = journey;

        if (journey.inQueue === 'pending' && journey.queueStartedAt) {
          const elapsed = Math.max(0, Math.floor((Date.now() - new Date(journey.queueStartedAt).getTime()) / 1000));
          if (elapsed !== journey.queueElapsedSec) {
            updated = { ...updated, queueElapsedSec: elapsed };
          }
        }

        let consumed = false;
        let consumedBy: string | null = null;

        if (journey.commandId) {
          const commandEvents = liveEvents.filter((ev) => {
            if (ev.type !== 'event') return false;
            const payload = asObject(ev.envelope?.payload);
            return payload.command_id === journey.commandId && typeof ev.routing_key === 'string';
          });

          const errorEvent = commandEvents.find((ev) => (ev.routing_key ?? '').endsWith('.error'));
          const resultEvent = commandEvents.find((ev) => (ev.routing_key ?? '').endsWith('.result'));
          const ackEvent = commandEvents.find((ev) => (ev.routing_key ?? '').endsWith('.ack'));

          if (errorEvent) {
            consumed = true;
            consumedBy = errorEvent.routing_key ?? null;
          } else if (resultEvent) {
            consumed = true;
            consumedBy = resultEvent.routing_key ?? null;
          } else if (ackEvent) {
            consumed = true;
            consumedBy = ackEvent.routing_key ?? null;
          }
        } else if (journey.eventId) {
          const liveMatch = liveEvents.find((ev) => ev.type === 'event' && ev.envelope?.event_id === journey.eventId);
          const historyMatch = historyEvents.find((ev) => ev.envelope?.event_id === journey.eventId);

          if (liveMatch) {
            consumed = true;
            consumedBy = liveMatch.routing_key ?? null;
          } else if (historyMatch) {
            consumed = true;
            consumedBy = historyMatch.routing_key ?? null;
          }
        }

        if (consumed && updated.consumed !== 'success') {
          updated = {
            ...updated,
            inQueue: 'success',
            consumed: 'success',
            consumedBy,
            note: consumedBy ? `Consumed via ${consumedBy}` : 'Consumed',
          };
        }

        if (
          updated.inQueue === 'pending' &&
          updated.queueStartedAt &&
          updated.consumed !== 'success'
        ) {
          const elapsed = Math.max(0, Math.floor((Date.now() - new Date(updated.queueStartedAt).getTime()) / 1000));
          if (elapsed >= updated.timeoutSeconds) {
            updated = {
              ...updated,
              queueElapsedSec: elapsed,
              inQueue: 'error',
              consumed: 'error',
              note: `Timed out waiting to be consumed (${updated.timeoutSeconds}s)`,
            };
          }
        }

        if (updated !== journey) {
          changed = true;
          next[schemaId] = updated;
        }
      }

      return changed ? next : prev;
    });
  }, [liveEvents, historyEvents]);

  useEffect(() => {
    const timer = setInterval(() => {
      setJourneys((prev) => {
        if (Object.keys(prev).length === 0) return prev;

        let changed = false;
        const next: Record<string, JourneyState> = { ...prev };

        for (const [schemaId, journey] of Object.entries(prev)) {
          if (journey.inQueue !== 'pending' || !journey.queueStartedAt) continue;

          const elapsed = Math.max(0, Math.floor((Date.now() - new Date(journey.queueStartedAt).getTime()) / 1000));
          let updated = journey;

          if (elapsed !== journey.queueElapsedSec) {
            updated = { ...updated, queueElapsedSec: elapsed };
          }

          if (elapsed >= journey.timeoutSeconds && journey.consumed !== 'success') {
            updated = {
              ...updated,
              inQueue: 'error',
              consumed: 'error',
              note: `Timed out waiting to be consumed (${journey.timeoutSeconds}s)`,
            };
          }

          if (updated !== journey) {
            changed = true;
            next[schemaId] = updated;
          }
        }

        return changed ? next : prev;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-950 text-slate-100">
      <div className="border-b border-slate-800 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">BloodBank Test Board</h2>
            <p className="text-sm text-slate-400">
              Schema-driven fire controls synced from Holyfields ({schemaCount} schemas)
            </p>
          </div>
          <div className="text-xs text-slate-400">
            {connected ? '🟢 Stream connected' : '🔴 Stream disconnected'}
            {' · '}
            {historyLoading ? 'Loading history…' : 'History loaded'}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            className="h-8 w-full max-w-sm rounded border border-slate-800 bg-slate-900 px-2 text-xs text-slate-200"
            placeholder="Filter schemas by title / path / event type"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <select
            className="h-8 rounded border border-slate-800 bg-slate-900 px-2 text-xs text-slate-200"
            value={catalogMode}
            onChange={(e) => setCatalogMode(e.target.value as 'vetted' | 'all')}
          >
            <option value="vetted">Vetted only</option>
            <option value="all">All schemas</option>
          </select>

          <select
            className="h-8 rounded border border-slate-800 bg-slate-900 px-2 text-xs text-slate-200"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as 'all' | 'command' | 'event')}
          >
            <option value="all">All</option>
            <option value="command">Commands</option>
            <option value="event">Events</option>
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="space-y-3">
          {filteredSchemas.map((entry) => {
            const isExpanded = Boolean(expanded[entry.id]);
            const draft = drafts[entry.id];
            const journey = journeys[entry.id];

            return (
              <section key={entry.id} className="rounded-lg border border-slate-800 bg-slate-900/40">
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => toggleExpanded(entry.id, entry.schema, entry.eventType)}
                  >
                    <div className="truncate text-sm font-semibold text-slate-200">
                      {isExpanded ? '▼' : '▶'} {entry.title}
                    </div>
                    <div className="truncate text-[11px] text-slate-500">{entry.eventType}</div>
                    <div className="truncate text-[10px] text-slate-600">{entry.schemaPath}</div>
                  </button>

                  <div className="flex flex-col items-end gap-2">
                    <JourneyTrack journey={journey} />

                    <button
                      type="button"
                      className="rounded border border-emerald-700 bg-emerald-700/20 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-700/30"
                      onClick={() => fireSchema(entry.id, entry.schema, entry.eventType, false)}
                    >
                      Fire minimal
                    </button>
                  </div>
                </div>

                {journey?.note ? (
                  <div className="border-t border-slate-800 px-3 py-1 text-[11px] text-slate-400">{journey.note}</div>
                ) : null}

                {isExpanded ? (
                  <div className="border-t border-slate-800 px-3 py-3">
                    {entry.description ? <p className="mb-3 text-xs text-slate-400">{entry.description}</p> : null}

                    {draft ? (
                      <div className="space-y-3">
                        <FieldEditor
                          label="root"
                          schema={entry.schema}
                          value={draft}
                          required={true}
                          path={[]}
                          onChange={(path, next) => {
                            if (path.length === 0) {
                              setDrafts((prev) => ({ ...prev, [entry.id]: next }));
                              return;
                            }
                            updateDraft(entry.id, path, next);
                          }}
                        />

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="rounded border border-blue-700 bg-blue-700/20 px-2 py-1 text-xs text-blue-300 hover:bg-blue-700/30"
                            onClick={() => fireSchema(entry.id, entry.schema, entry.eventType, true)}
                          >
                            Fire with form values
                          </button>

                          <button
                            type="button"
                            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                            onClick={() => {
                              const reset = ensureRuntimeEnvelopeCompatibility(buildDefaultValue(entry.schema), entry.eventType);
                              setDrafts((prev) => ({ ...prev, [entry.id]: reset }));
                            }}
                          >
                            Reset to defaults
                          </button>
                        </div>

                        <details>
                          <summary className="cursor-pointer text-xs text-slate-500">JSON preview</summary>
                          <pre className="mt-2 overflow-x-auto rounded border border-slate-800 bg-slate-950 p-2 text-[11px] text-slate-300">
                            {JSON.stringify(draft, null, 2)}
                          </pre>
                        </details>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
};

type Json = Record<string, unknown>;
type Check = (value: unknown) => boolean;
export const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const text: Check = value => typeof value === "string";
const number: Check = value => typeof value === "number" && Number.isFinite(value);
const integer: Check = value => number(value) && Number.isSafeInteger(value) && (value as number) >= 0;
const boolean: Check = value => typeof value === "boolean";
const time: Check = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullable = (check: Check): Check => value => value === null || check(value);
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const object = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => value =>
  isRecord(value) && Object.entries(required).every(([key, check]) => check(value[key])) &&
  Object.entries(optional).every(([key, check]) => !(key in value) || check(value[key]));
const strings = array(text);
const activity = object({ cli: text, native: text, invocations: integer }, {
  last_received_at: time, deduplicated: integer, failed: integer, interrupted: integer,
});
const source = object({ source: text, hub_count: integer, direct_count: integer, issues: strings });
const native = object({ native: text, status: text }, {
  role: nullable(text), expected_count: integer, actual_hub_count: integer, direct_managed_count: integer, sources: array(source),
});
const config = object({ source: text, status: text }, { label: text, errors: strings });
const cli = object({ cli: text, support_status: text, status: text, configs: array(config), natives: array(native) }, {
  label: text, binary_available: boolean, trust_verification: text,
});
const inventory = object({ generated_at: time, status: text, clis: array(cli) }, { reason: text });
const binding = object({ cli: text, native: text, configured: boolean, handler_ids: strings }, {
  role: nullable(text), support_status: text, event_type: nullable(text), state: text, observed_state: text,
  activity: nullable(activity), installation: nullable(native),
});
const handler = object({ id: text, mode: text, enabled: boolean, state: text }, {
  on: strings, on_native: strings, clis: strings, timeout_ms: integer, order: number, after: strings, require_env: strings, match_tool: nullable(text),
});
const hub = object({ state: text, started_at: time, publish_enabled: boolean }, {
  pid: integer, async_running: integer, registry_error: nullable(text), journal_error: nullable(text), transport_error: nullable(text),
  socket: object({}, { path: nullable(text), present: nullable(boolean), activated: boolean }),
  observation_delivery: object({ pending: integer, enabled: boolean }, { last_acked_at: nullable(text), last_acked_sequence: nullable(integer), error: nullable(text) }),
});
const handlerActivity = object({ handler_id: text, cli: text, status: text, count: integer }, { last_at: nullable(text), mean_duration_ms: nullable(number) });
const totals: Check = value => isRecord(value) && Object.values(value).every(integer);
const common = { schema_version: (value: unknown) => value === 1, generated_at: time, hub, totals, handler_activity: array(handlerActivity) };
const observed = { native_activity: array(activity), observed_since: nullable(text) };
export const validHeartbeat = object(common, observed);
const validSnapshot = object({ ...common, bindings: array(binding), handlers: array(handler) }, { ...observed, installed_inventory: inventory });
const execution = object({ handler_id: text, mode: text, status: text, selected_at: time }, {
  invocation_id: text, reason: nullable(text), started_at: nullable(text), finished_at: nullable(text), duration_ms: nullable(number),
  exit_code: nullable(number), event_id: nullable(text), event_type: nullable(text), publish_status: nullable(text),
});
const transition = object({ sequence: integer, status: text, at: time }, { handler_id: nullable(text), reason: nullable(text) });
export const validInvocation = object({
  invocation_id: text, cli: text, native: text, received_at: time, updated_at: time, status: text, executions: array(execution), timeline: array(transition),
}, { role: nullable(text), event_type: nullable(text), session_id: nullable(text), identity_kind: text, deduplicated: integer, timeline_total: integer, timeline_truncated: boolean });

/** Enforce every nested field used by the view before persistence; default only schema-optional fields. */
export function safeSnapshot(value: unknown): Json | null {
  if (!validSnapshot(value)) return null;
  const snapshot = value as Json;
  const installation = snapshot.installed_inventory as Json | undefined;
  return {
    ...snapshot,
    bindings: (snapshot.bindings as Json[]).map(row => ({ ...row, role: row.role ?? "unmapped", state: row.state ?? "unobserved" })),
    handlers: (snapshot.handlers as Json[]).map(row => ({ ...row, on: row.on ?? [], on_native: row.on_native ?? [], clis: row.clis ?? [] })),
    ...(installation ? { installed_inventory: { ...installation, clis: (installation.clis as Json[]).map(row => ({
      ...row,
      configs: (row.configs as Json[]).map(entry => ({ ...entry, errors: entry.errors ?? [] })),
      natives: (row.natives as Json[]).map(entry => ({ ...entry, sources: entry.sources ?? [] })),
    })) } } : {}),
  };
}

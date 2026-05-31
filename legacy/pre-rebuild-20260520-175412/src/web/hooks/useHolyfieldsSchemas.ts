import { useMemo } from 'react';

type JsonSchema = {
  $id?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  format?: string;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  default?: unknown;
  minimum?: number;
  minLength?: number;
  minItems?: number;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  $ref?: string;
  [key: string]: unknown;
};

export type HolyfieldsSchema = {
  id: string;
  schemaPath: string;
  title: string;
  description: string;
  eventType: string;
  kind: 'command' | 'event';
  schema: JsonSchema;
};

const RAW_SCHEMAS = import.meta.glob('../data/holyfields-schemas/**/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, JsonSchema>;

function normalizePath(path: string): string {
  const match = path.match(/holyfields-schemas\/(.*)$/);
  return match?.[1] ?? path;
}

function getPathWithoutVersion(schemaPath: string): string {
  return schemaPath.replace(/\.v\d+\.json$/i, '').replace(/\.json$/i, '');
}

function deriveEventType(schema: JsonSchema, schemaPath: string): string {
  const eventTypeProp = schema.properties?.event_type;
  if (eventTypeProp?.const && typeof eventTypeProp.const === 'string') {
    return eventTypeProp.const;
  }

  return getPathWithoutVersion(schemaPath).replace(/\//g, '.');
}

function mergeSchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  const merged: JsonSchema = {
    ...a,
    ...b,
  };

  const mergedProps = {
    ...(a.properties ?? {}),
    ...(b.properties ?? {}),
  };

  if (Object.keys(mergedProps).length > 0) {
    merged.properties = mergedProps;
  }

  const required = Array.from(new Set([...(a.required ?? []), ...(b.required ?? [])]));
  if (required.length > 0) {
    merged.required = required;
  }

  return merged;
}

function resolveJsonPointer(target: JsonSchema, pointer: string): JsonSchema {
  const segments = pointer
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current: unknown = target;
  for (const segment of segments) {
    if (current && typeof current === 'object' && segment in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return {};
    }
  }

  return current && typeof current === 'object' ? (current as JsonSchema) : {};
}

function chooseBranch(schema: JsonSchema): JsonSchema | null {
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return schema.oneOf[0] ?? null;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return schema.anyOf[0] ?? null;
  return null;
}

function resolveSchema(
  node: JsonSchema,
  currentPath: string,
  byPath: Map<string, JsonSchema>,
  byId: Map<string, JsonSchema>,
  depth = 0,
  seen = new Set<string>()
): JsonSchema {
  if (!node || typeof node !== 'object') return {};
  if (depth > 20) return node;

  if (node.$ref && typeof node.$ref === 'string') {
    const ref = node.$ref;
    const cacheKey = `${currentPath}::${ref}`;
    if (seen.has(cacheKey)) return node;
    seen.add(cacheKey);

    const [refPathRaw, pointerRaw] = ref.split('#');
    const pointer = pointerRaw ? `#${pointerRaw}` : '';

    let resolvedRef: JsonSchema = {};

    if (!refPathRaw || refPathRaw.length === 0) {
      resolvedRef = resolveJsonPointer(byPath.get(currentPath) ?? {}, pointer || '#');
    } else if (refPathRaw.startsWith('https://') || refPathRaw.startsWith('http://')) {
      const target = byId.get(refPathRaw) ?? {};
      resolvedRef = pointer ? resolveJsonPointer(target, pointer) : target;
    } else {
      const absoluteRefPath = normalizePosixPath(joinPosix(dirnamePosix(currentPath), refPathRaw));
      const target = byPath.get(absoluteRefPath) ?? {};
      resolvedRef = pointer ? resolveJsonPointer(target, pointer) : target;
    }

    const resolvedNode = resolveSchema(resolvedRef, currentPath, byPath, byId, depth + 1, seen);
    const withoutRef = { ...node };
    delete withoutRef.$ref;

    return resolveSchema(
      mergeSchemas(resolvedNode, withoutRef),
      currentPath,
      byPath,
      byId,
      depth + 1,
      seen
    );
  }

  const chosen = chooseBranch(node);
  if (chosen) {
    return resolveSchema(chosen, currentPath, byPath, byId, depth + 1, seen);
  }

  let working = { ...node };

  if (Array.isArray(working.allOf) && working.allOf.length > 0) {
    const merged = working.allOf
      .map((item) => resolveSchema(item, currentPath, byPath, byId, depth + 1, seen))
      .reduce<JsonSchema>((acc, item) => mergeSchemas(acc, item), {});

    const withoutAllOf = { ...working };
    delete withoutAllOf.allOf;
    working = mergeSchemas(merged, withoutAllOf);
  }

  if (working.properties) {
    const nextProps: Record<string, JsonSchema> = {};
    for (const [key, child] of Object.entries(working.properties)) {
      nextProps[key] = resolveSchema(child, currentPath, byPath, byId, depth + 1, seen);
    }
    working.properties = nextProps;
  }

  if (working.items && typeof working.items === 'object') {
    working.items = resolveSchema(working.items, currentPath, byPath, byId, depth + 1, seen);
  }

  return working;
}

function dirnamePosix(input: string): string {
  const idx = input.lastIndexOf('/');
  if (idx <= 0) return '';
  return input.slice(0, idx);
}

function joinPosix(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}

function normalizePosixPath(input: string): string {
  const parts = input.split('/');
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }

  return stack.join('/');
}

export function useHolyfieldsSchemas() {
  return useMemo(() => {
    const byPath = new Map<string, JsonSchema>();
    const byId = new Map<string, JsonSchema>();

    for (const [rawPath, rawSchema] of Object.entries(RAW_SCHEMAS)) {
      const schemaPath = normalizePath(rawPath);
      byPath.set(schemaPath, rawSchema);
      if (rawSchema.$id && typeof rawSchema.$id === 'string') {
        byId.set(rawSchema.$id, rawSchema);
      }
    }

    const schemas: HolyfieldsSchema[] = [];

    for (const [schemaPath, rawSchema] of byPath.entries()) {
      if (schemaPath.startsWith('_common/')) continue;
      if (schemaPath.endsWith('manifest.json')) continue;

      const resolved = resolveSchema(rawSchema, schemaPath, byPath, byId);
      const eventType = deriveEventType(resolved, schemaPath);
      const kind: HolyfieldsSchema['kind'] = schemaPath.startsWith('command/') ? 'command' : 'event';

      schemas.push({
        id: resolved.$id ?? schemaPath,
        schemaPath,
        title: resolved.title ?? schemaPath,
        description: resolved.description ?? '',
        eventType,
        kind,
        schema: resolved,
      });
    }

    schemas.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'command' ? -1 : 1;
      return a.eventType.localeCompare(b.eventType);
    });

    return { schemas, schemaCount: schemas.length };
  }, []);
}

export type { JsonSchema };

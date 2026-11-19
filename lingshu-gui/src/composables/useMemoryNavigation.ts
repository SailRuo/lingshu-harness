import type { RouteLocationRaw } from 'vue-router';

export type MemoryNavActive = 'echo' | 'sea' | 'graph';

export interface MemoryNavQuery {
  memoryId?: string;
  impressionId?: string;
  entityId?: string;
  query?: string;
}

function compactQuery(query: MemoryNavQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (query.memoryId?.trim()) out.memoryId = query.memoryId.trim();
  const entity = query.entityId?.trim() || query.impressionId?.trim();
  if (entity) out.entityId = entity;
  if (query.impressionId?.trim()) out.impressionId = query.impressionId.trim();
  if (query.query?.trim()) out.query = query.query.trim();
  return out;
}

export function memoryEchoRoute(query: MemoryNavQuery = {}): RouteLocationRaw {
  return { name: 'chat', query: compactQuery(query) };
}

export function memorySeaRoute(query: MemoryNavQuery = {}): RouteLocationRaw {
  return { name: 'memory-graph', query: compactQuery(query) };
}

export function memoryStreamRoute(streamId: string): RouteLocationRaw {
  return { name: 'memory-streams', query: { id: streamId } };
}

export function memorySeedRoute(seedId: string): RouteLocationRaw {
  return { name: 'memory-seeds', query: { id: seedId } };
}

export function memoryGraphRoute(query: MemoryNavQuery = {}): RouteLocationRaw {
  const q = compactQuery(query);
  if (q.impressionId) {
    return { name: 'memory-graph', query: { entityId: q.impressionId, ...q } };
  }
  return { name: 'memory-graph', query: q };
}

export function resolveSnippetTargetId(snippet: {
  id: string;
  sourceId?: string | null;
}): string {
  const sourceId = String(snippet.sourceId || '').trim();
  return sourceId || String(snippet.id || '').trim();
}

export function graphQueryFromSnippet(snippet: {
  id: string;
  sourceId?: string | null;
  text?: string;
}): MemoryNavQuery {
  const impressionId = resolveSnippetTargetId(snippet);
  if (impressionId) return { impressionId };
  const text = String(snippet.text || '').trim();
  if (text) return { query: text.slice(0, 80) };
  return {};
}

export function seaQueryFromSnippet(snippet: {
  id: string;
  sourceId?: string | null;
}): MemoryNavQuery {
  const memoryId = resolveSnippetTargetId(snippet);
  return memoryId ? { memoryId } : {};
}

type RouterQueryValue = string | null | undefined;
export type LocationQueryShape = Record<string, RouterQueryValue | RouterQueryValue[]>;

export function readMemoryNavQuery(raw: LocationQueryShape): MemoryNavQuery {
  const pick = (key: string): string => {
    const value = raw[key];
    if (Array.isArray(value)) {
      const first = value.find((v) => typeof v === 'string') as string | undefined;
      return first || '';
    }
    return typeof value === 'string' ? value : '';
  };
  return {
    memoryId: pick('memoryId'),
    impressionId: pick('impressionId') || pick('entityId'),
    entityId: pick('entityId'),
    query: pick('query'),
  };
}

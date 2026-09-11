import type { NodeRecord, RelRecord, GraphData, CypherResult, ExportData } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? '请求失败');
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function qs(q: Record<string, string | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface TableSchema { system: string[]; dynamic: string[] }
export interface SchemaInfo { node: TableSchema; rel: TableSchema }

export const api = {
  listNodes: (q: { name?: string; type?: string; includeDeleted?: boolean; includeDeprecate?: boolean } = {}) =>
    req<NodeRecord[]>(`/api/nodes${qs(q)}`),
  createNode: (body: { name: string; type?: string; description?: string; attrs?: Record<string, string>; is_deprecate?: boolean }) =>
    req<NodeRecord>('/api/nodes', { method: 'POST', body: JSON.stringify(body) }),
  updateNode: (id: string, body: Partial<{ name: string; type: string; description: string; attrs: Record<string, string>; is_deprecate: boolean }>) =>
    req<NodeRecord>(`/api/nodes/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteNode: (id: string) => req<void>(`/api/nodes/${id}`, { method: 'DELETE' }),
  restoreNode: (id: string) => req<NodeRecord>(`/api/nodes/${id}/restore`, { method: 'POST' }),
  getTypes: () => req<string[]>('/api/types'),

  listRels: (q: { nodeId?: string; includeDeleted?: boolean } = {}) =>
    req<RelRecord[]>(`/api/rels${qs(q)}`),
  createRel: (body: { type: string; from: string; to: string; description?: string; attrs?: Record<string, string>; is_deprecate?: boolean }) =>
    req<RelRecord>('/api/rels', { method: 'POST', body: JSON.stringify(body) }),
  updateRel: (id: string, body: Partial<{ type: string; description: string; attrs: Record<string, string>; is_deprecate: boolean }>) =>
    req<RelRecord>(`/api/rels/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteRel: (id: string) => req<void>(`/api/rels/${id}`, { method: 'DELETE' }),
  restoreRel: (id: string) => req<RelRecord>(`/api/rels/${id}/restore`, { method: 'POST' }),

  getSchema: () => req<SchemaInfo>('/api/schema'),

  getGraph: (q: { includeDeprecate?: boolean; includeDeleted?: boolean } = {}) =>
    req<GraphData>(`/api/graph${qs(q)}`),
  getGraphAround: (nodeId: string, depth: number | 'all', q: { includeDeprecate?: boolean; includeDeleted?: boolean } = {}) =>
    req<GraphData>(`/api/graph/${nodeId}${qs({ depth: String(depth), ...q })}`),

  queryCypher: (cypher: string) =>
    req<CypherResult>('/api/query', { method: 'POST', body: JSON.stringify({ cypher }) }),

  exportJson: (includeDeleted = false) => req<ExportData>(`/api/export${qs({ includeDeleted })}`),
  importJson: (data: unknown, mode: 'merge' | 'replace') =>
    req<{ nodes: number; rels: number }>('/api/import', { method: 'POST', body: JSON.stringify({ data, mode }) }),
};

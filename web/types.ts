export interface NodeRecord {
  id: string;
  name: string;
  type: string;
  description: string;
  attrs: Record<string, string>;
  created_time: string;
  updated_time: string;
  deleted_time: string | null;
  is_deprecate: boolean;
}

export interface RelRecord {
  id: string;
  type: string;
  from: string;
  to: string;
  description: string;
  attrs: Record<string, string>;
  created_time: string;
  updated_time: string;
  deleted_time: string | null;
  is_deprecate: boolean;
}

export interface GraphData { nodes: NodeRecord[]; edges: RelRecord[]; centerId?: string }

export interface CypherResult { columns: string[]; rows: unknown[][] }

export interface ExportData {
  nodes: Array<{ name: string; type?: string; description?: string; is_deprecate?: boolean; created_time?: string; updated_time?: string; deleted_time?: string | null } & Record<string, unknown>>;
  rels: Array<{ type: string; from: string; to: string; description?: string; is_deprecate?: boolean; created_time?: string; updated_time?: string; deleted_time?: string | null } & Record<string, unknown>>;
}

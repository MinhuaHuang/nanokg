export interface NodeRecord {
  id: string;
  name: string;
  type: string;                      // 节点类型，如「系统」「接口」，空串表示未分类
  description: string;
  attrs: Record<string, string>;     // 动态扩展属性（全 STRING 列），不含系统字段
  created_time: string;              // ISO
  updated_time: string;              // ISO
  deleted_time: string | null;
  is_deprecate: boolean;
}

export interface RelRecord {
  id: string;
  type: string;
  from: string;                      // 源节点 id
  to: string;                        // 目标节点 id
  description: string;
  attrs: Record<string, string>;
  created_time: string;
  updated_time: string;
  deleted_time: string | null;
  is_deprecate: boolean;
}

export interface GraphData {
  nodes: NodeRecord[];
  edges: RelRecord[];
}

export interface NodeInput {
  name: string;
  type?: string;
  description?: string;
  attrs?: Record<string, string>;
  is_deprecate?: boolean;
}

export interface RelInput {
  type: string;
  from: string;
  to: string;
  description?: string;
  attrs?: Record<string, string>;
  is_deprecate?: boolean;
}

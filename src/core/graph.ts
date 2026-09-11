import { withDb, queryAll } from './db.js';
import { ensureSchema } from './schema.js';
import { enqueueDbOp } from './serialize.js';
import { rowToNode, rowToRel } from './rows.js';
import { KgError } from './errors.js';
import type { GraphData, NodeRecord, RelRecord } from './types.js';

/** 图查询条件：includeDeleted 默认 false（排除软删）；includeDeprecate 默认 true（含弃用） */
export interface GraphOpts {
  includeDeprecate?: boolean;
  includeDeleted?: boolean;
}

/**
 * 全量图（默认未软删的节点与边；includeDeleted=true 含软删）。边查询同时排除端点已删的边，级联一致性双保险。
 * includeDeprecate=false 时节点加 NOT is_deprecate，边同步过滤自身弃用与端点弃用（端点被排除的边悬空，不返回）。
 */
export async function getGraph(dbPath: string, opts: GraphOpts = {}): Promise<GraphData> {
  await ensureSchema(dbPath);
  return enqueueDbOp(dbPath, () => withDb(dbPath, async (conn) => {
    const nodeConds: string[] = [];
    if (!opts.includeDeleted) nodeConds.push('n.deleted_time IS NULL');
    if (opts.includeDeprecate === false) nodeConds.push('NOT n.is_deprecate');
    const edgeConds: string[] = [];
    if (!opts.includeDeleted) {
      edgeConds.push('r.deleted_time IS NULL', 'a.deleted_time IS NULL', 'b.deleted_time IS NULL');
    }
    if (opts.includeDeprecate === false) edgeConds.push('NOT r.is_deprecate', 'NOT a.is_deprecate', 'NOT b.is_deprecate');
    const nodeWhere = nodeConds.length ? `WHERE ${nodeConds.join(' AND ')}` : '';
    const edgeWhere = edgeConds.length ? `WHERE ${edgeConds.join(' AND ')}` : '';
    const nodes = (await queryAll(conn,
      `MATCH (n:Node) ${nodeWhere} RETURN n.*`,
    )).map(rowToNode);
    const edges = (await queryAll(conn,
      `MATCH (a:Node)-[r:Rel]->(b:Node)
       ${edgeWhere}
       RETURN r.*, a.id AS from_id, b.id AS to_id`,
    )).map(rowToRel);
    return { nodes, edges };
  }));
}

/**
 * 中心 nodeId 的 depth 跳方向一致邻域（默认 5，'all' 不限）。
 * 正向 BFS 只沿出边、反向 BFS 只沿入边，各自独立跑——方向翻转只发生在中心节点，
 * 即收录 中心->A->B / 中心<-C<-D / B<-A<-中心->E->F 型链路，不含 中心->A<-B 型。
 * 实现：全量拉取后内存 BFS——规避数据库变长路径 API，且天然跳过已软删节点/边。
 * 唯一 DB 访问是 getGraph（已队列化）；本函数不再包 enqueueDbOp，嵌套会死锁。
 */
export async function getGraphAround(
  dbPath: string,
  nodeId: string,
  depth: number | 'all' = 5,
  opts: GraphOpts = {},
): Promise<GraphData & { centerId: string }> {
  const { nodes, edges } = await getGraph(dbPath, opts);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(nodeId)) throw new KgError(`节点不存在: ${nodeId}`);

  const outAdj = new Map<string, RelRecord[]>();
  const inAdj = new Map<string, RelRecord[]>();
  for (const e of edges) {
    if (!outAdj.has(e.from)) outAdj.set(e.from, []);
    outAdj.get(e.from)!.push(e);
    if (!inAdj.has(e.to)) inAdj.set(e.to, []);
    inAdj.get(e.to)!.push(e);
  }

  const usedEdges = new Set<string>();
  const maxDepth = depth === 'all' ? Number.POSITIVE_INFINITY : depth;
  const bfs = (adj: Map<string, RelRecord[]>) => {
    const visited = new Set<string>([nodeId]);
    let frontier = new Set<string>([nodeId]);
    let d = 0;
    while (frontier.size > 0 && d < maxDepth) {
      const next = new Set<string>();
      for (const cur of frontier) {
        for (const e of adj.get(cur) ?? []) {
          usedEdges.add(e.id);
          const other = e.from === cur ? e.to : e.from;
          if (!visited.has(other)) { visited.add(other); next.add(other); }
        }
      }
      frontier = next;
      d++;
    }
    return visited;
  };
  const visited = new Set<string>([...bfs(outAdj), ...bfs(inAdj)]);

  const subNodes: NodeRecord[] = [...visited].map((id) => byId.get(id)!);
  const subEdges: RelRecord[] = edges.filter((e) => usedEdges.has(e.id));
  return { nodes: subNodes, edges: subEdges, centerId: nodeId };
}

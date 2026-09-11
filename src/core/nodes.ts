import { randomUUID } from 'node:crypto';
import { withDb, queryAll, execBound } from './db.js';
import { ensureSchema, withRetry } from './schema.js';
import { enqueueDbOp } from './serialize.js';
import { tsParam } from './cypher.js';
import { rowToNode } from './rows.js';
import { ensureAttrColumns } from './attrs.js';
import { KgError } from './errors.js';
import type { NodeRecord, NodeInput } from './types.js';

/** 非空 attrs key 清单（空串 key 忽略） */
function attrKeys(attrs: Record<string, string> | undefined): string[] {
  return attrs ? Object.keys(attrs).filter((k) => k.length > 0) : [];
}

/** attrs → CREATE 内联列片段与绑定参数（列名已经 ensureAttrColumns 校验 [A-Za-z0-9_]） */
function attrCreateFragments(attrs: Record<string, string>, keys: string[]): {
  cols: string; params: Record<string, unknown>;
} {
  const params: Record<string, unknown> = {};
  for (const k of keys) params[`a_${k}`] = attrs[k];
  return { cols: keys.map((k) => `${k}: $a_${k}`).join(', '), params };
}

export async function listNodes(
  dbPath: string,
  opts: {
    nameLike?: string;
    type?: string;              // 精确匹配（= 绑定）；空/缺省不过滤
    includeDeleted?: boolean;   // 默认 false：排除软删
    includeDeprecate?: boolean; // 默认 true；false 排除 is_deprecate
  } = {},
): Promise<NodeRecord[]> {
  await ensureSchema(dbPath);
  return enqueueDbOp(dbPath, () => withDb(dbPath, async (conn) => {
    const conds: string[] = [opts.includeDeleted ? 'true' : 'n.deleted_time IS NULL'];
    const params: Record<string, unknown> = {};
    if (opts.includeDeprecate === false) conds.push('NOT n.is_deprecate');
    if (opts.nameLike) { conds.push('n.name CONTAINS $like'); params.like = opts.nameLike; }
    if (opts.type) { conds.push('n.type = $type'); params.type = opts.type; }
    const rows = await execBound(conn,
      `MATCH (n:Node) WHERE ${conds.join(' AND ')} RETURN n.* ORDER BY n.name`, params);
    return rows.map(rowToNode);
  }));
}

/** 库中已存在的节点类型清单（未删节点 DISTINCT，排除空串，按字典序；弃用节点的 type 也算存在） */
export async function listNodeTypes(dbPath: string): Promise<string[]> {
  await ensureSchema(dbPath);
  return enqueueDbOp(dbPath, () => withDb(dbPath, async (conn) => {
    const rows = await queryAll(conn,
      `MATCH (n:Node) WHERE n.deleted_time IS NULL AND n.type <> '' RETURN DISTINCT n.type AS t ORDER BY t`);
    return rows.map((r) => String(r['t']));
  }));
}

export async function getNode(dbPath: string, id: string): Promise<NodeRecord | null> {
  await ensureSchema(dbPath);
  return enqueueDbOp(dbPath, () => withDb(dbPath, async (conn) => {
    const rows = await execBound(conn,
      `MATCH (n:Node {id: $id}) RETURN n.*`, { id });
    return rows.length ? rowToNode(rows[0]) : null;
  }));
}

export async function createNode(dbPath: string, input: NodeInput): Promise<NodeRecord> {
  await ensureSchema(dbPath);
  return enqueueDbOp(dbPath, () => withRetry(() => withDb(dbPath, async (conn) => {
    // name 唯一性仅限未删行：软删后同 name 可重建（旧软删行保留痕迹，新行新 uuid）
    const dup = await execBound(conn,
      `MATCH (n:Node) WHERE n.name = $name AND n.deleted_time IS NULL RETURN count(n) AS c`,
      { name: input.name });
    if (Number(dup[0]['c']) > 0) throw new KgError(`节点名称已存在: ${input.name}`);
    const id = randomUUID(); // 创建时生成，永不随改名变
    const keys = attrKeys(input.attrs);
    if (keys.length) await ensureAttrColumns(conn, 'Node', input.attrs!);
    const { cols: attrCols, params: attrParams } =
      keys.length ? attrCreateFragments(input.attrs!, keys) : { cols: '', params: {} };
    const nowStr = tsParam(new Date())!;
    await execBound(conn, `CREATE (n:Node {
      id: $id, name: $name, type: $type, description: $descr,
      created_time: timestamp($ct), updated_time: timestamp($ut), deleted_time: NULL, is_deprecate: $dep${attrCols ? `, ${attrCols}` : ''}
    })`, {
      id, name: input.name, type: input.type ?? '', descr: input.description ?? '',
      ct: nowStr, ut: nowStr, dep: input.is_deprecate ?? false,
      ...attrParams,
    });
    // 写后断言：CREATE 竞态零命中是静默 no-op（实测），回查防幻象成功
    const back = await execBound(conn, `MATCH (n:Node {id: $id}) RETURN n.*`, { id });
    if (!back.length) throw new KgError('节点创建失败');
    return rowToNode(back[0]);
  })));
}

export async function updateNode(
  dbPath: string,
  id: string,
  patch: Partial<NodeInput>,
): Promise<NodeRecord> {
  await ensureSchema(dbPath);
  return enqueueDbOp(dbPath, () => withRetry(() => withDb(dbPath, async (conn) => {
    const cur = await execBound(conn,
      `MATCH (n:Node {id: $id}) WHERE n.deleted_time IS NULL RETURN count(n) AS c`, { id });
    if (Number(cur[0]['c']) === 0) throw new KgError(`节点不存在: ${id}`);
    if (patch.name !== undefined) {
      // 同 createNode：冲突检测仅限未删行（改名撞软删行的 name 不算冲突）
      const dup = await execBound(conn,
        `MATCH (n:Node) WHERE n.name = $name AND n.id <> $id AND n.deleted_time IS NULL RETURN count(n) AS c`,
        { name: patch.name, id });
      if (Number(dup[0]['c']) > 0) throw new KgError(`节点名称已存在: ${patch.name}`);
    }
    const nowStr = tsParam(new Date())!;
    // 实测：SET 的 TIMESTAMP 列不接受 STRING 参数（无隐式转换），须 timestamp($ut) 包一层
    const sets: string[] = ['n.updated_time = timestamp($ut)'];
    const params: Record<string, unknown> = { id, ut: nowStr };
    if (patch.name !== undefined) { sets.push('n.name = $name'); params.name = patch.name; }
    if (patch.type !== undefined) { sets.push('n.type = $type'); params.type = patch.type; }
    if (patch.description !== undefined) { sets.push('n.description = $descr'); params.descr = patch.description; }
    if (patch.is_deprecate !== undefined) { sets.push('n.is_deprecate = $dep'); params.dep = patch.is_deprecate; }
    if (patch.attrs !== undefined) {
      const keys = attrKeys(patch.attrs);
      if (keys.length) {
        await ensureAttrColumns(conn, 'Node', patch.attrs!);
        // 只 SET 提交的 key：未提交的动态列原值保留（不删除动态列）
        for (const k of keys) { sets.push(`n.${k} = $a_${k}`); params[`a_${k}`] = patch.attrs![k]; }
      }
    }
    await execBound(conn, `MATCH (n:Node {id: $id}) SET ${sets.join(', ')}`, params);
    const rows = await execBound(conn,
      `MATCH (n:Node {id: $id}) WHERE n.deleted_time IS NULL RETURN n.*`, { id });
    if (!rows.length) throw new KgError(`节点不存在: ${id}`);
    return rowToNode(rows[0]);
  })));
}

export async function deleteNode(dbPath: string, id: string): Promise<void> {
  await ensureSchema(dbPath);
  await enqueueDbOp(dbPath, () => withRetry(() => withDb(dbPath, async (conn) => {
    // 契约：不存在（含已软删）须抛错，server 层据此 404；静默 no-op 无法区分
    const cur = await execBound(conn,
      `MATCH (n:Node {id: $id}) WHERE n.deleted_time IS NULL RETURN count(n) AS c`, { id });
    if (Number(cur[0]['c']) === 0) throw new KgError(`节点不存在: ${id}`);
    const nowStr = tsParam(new Date())!;
    // 级联软删关联边（两步：出边 + 入边）
    await execBound(conn,
      `MATCH (a:Node {id: $id})-[r:Rel]->() WHERE r.deleted_time IS NULL SET r.deleted_time = timestamp($now)`,
      { id, now: nowStr });
    await execBound(conn,
      `MATCH ()-[r:Rel]->(b:Node {id: $id}) WHERE r.deleted_time IS NULL SET r.deleted_time = timestamp($now)`,
      { id, now: nowStr });
    await execBound(conn,
      `MATCH (n:Node {id: $id}) SET n.deleted_time = timestamp($now)`, { id, now: nowStr });
  })));
}

/** 还原软删节点：deleted_time 置 NULL，其关联软删边按 id 逐条判定还原。
 * 边还原条件：该 id 无未删行 且 软删行恰 1 条 且 对端未删——同 id 多条软删行（软删后重建又被级联软删）
 * 歧义一条都不还原（保持删痕）；对端仍软删的边不还原，待对端还原时其级联带回。
 * 未删/不存在 → KgError('节点不存在: id')；未删行存在同名 → KgError('节点名称已存在: name')（还原会让重名违反唯一性）。 */
export async function restoreNode(dbPath: string, id: string): Promise<NodeRecord> {
  await ensureSchema(dbPath);
  return enqueueDbOp(dbPath, () => withRetry(() => withDb(dbPath, async (conn) => {
    // 契约：不存在或未删（deleted_time IS NULL）均抛「节点不存在」，server 层据此 404
    const cur = await execBound(conn,
      `MATCH (n:Node {id: $id}) WHERE n.deleted_time IS NOT NULL RETURN n.name AS name`, { id });
    if (!cur.length) throw new KgError(`节点不存在: ${id}`);
    const name = String(cur[0]['name']);
    // 还原名冲突：唯一性仅限未删行，未删行占名时还原即重名
    const dup = await execBound(conn,
      `MATCH (n:Node) WHERE n.name = $name AND n.deleted_time IS NULL RETURN count(n) AS c`, { name });
    if (Number(dup[0]['c']) > 0) throw new KgError(`节点名称已存在: ${name}`);
    // 收集该节点两端的边（rid + 边/对端存活态），JS 按 id 判定后逐条还原。
    // rel id 由 (from,to,type) 确定性生成：同 id 行端点相同 → 关联行集合即该 id 全部行，计数即全局计数。
    // 时间戳判新旧不可靠：tsParam 秒精度，deleteRel 与 deleteNode 同秒时两条边 deleted_time 相等 → 用计数规则。
    const outRows = await execBound(conn,
      `MATCH (a:Node {id: $id})-[r:Rel]->(b:Node)
       RETURN r.id AS rid, r.deleted_time AS rdt, b.deleted_time AS pdt`, { id });
    const inRows = await execBound(conn,
      `MATCH (a:Node)-[r:Rel]->(b:Node {id: $id})
       RETURN r.id AS rid, r.deleted_time AS rdt, a.deleted_time AS pdt`, { id });
    const liveIds = new Set<string>();
    const soft = new Map<string, { count: number; peerAlive: boolean }>();
    for (const row of [...outRows, ...inRows]) {
      const rid = String(row['rid']);
      if (row['rdt'] === null || row['rdt'] === undefined) { liveIds.add(rid); continue; }
      const peerAlive = row['pdt'] === null || row['pdt'] === undefined;
      const info = soft.get(rid);
      if (info) info.count += 1;
      else soft.set(rid, { count: 1, peerAlive });
    }
    for (const [rid, info] of soft) {
      // 有未删行（重建占位）/ 多条软删行（歧义）/ 对端仍软删 → 均不还原
      if (liveIds.has(rid) || info.count !== 1 || !info.peerAlive) continue;
      await execBound(conn,
        `MATCH ()-[r:Rel {id: $rid}]->() WHERE r.deleted_time IS NOT NULL SET r.deleted_time = NULL`, { rid });
    }
    await execBound(conn,
      `MATCH (n:Node {id: $id}) SET n.deleted_time = NULL`, { id });
    // 写后断言：回读行 deleted_time IS NULL，防幻象成功
    const rows = await execBound(conn,
      `MATCH (n:Node {id: $id}) RETURN n.*`, { id });
    const restored = rows.length ? rowToNode(rows[0]) : null;
    if (!restored || restored.deleted_time !== null) throw new KgError(`节点还原失败: ${id}`);
    return restored;
  })));
}

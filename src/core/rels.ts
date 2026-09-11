import { withDb, queryAll, execBound } from './db.js';
import { ensureSchema, withRetry } from './schema.js';
import { enqueueDbOp } from './serialize.js';
import { tsParam } from './cypher.js';
import { rowToRel } from './rows.js';
import { ensureAttrColumns } from './attrs.js';
import { relIdOf } from './id.js';
import { KgError } from './errors.js';
import { restoreNode } from './nodes.js';
import type { RelRecord, RelInput } from './types.js';

/** 非空 attrs key 清单（空串 key 忽略） */
function attrKeys(attrs: Record<string, string> | undefined): string[] {
  return attrs ? Object.keys(attrs).filter((k) => k.length > 0) : [];
}

export async function listRels(
  dbPath: string,
  opts: { nodeId?: string; includeDeleted?: boolean } = {},
): Promise<RelRecord[]> {
  await ensureSchema(dbPath);
  return enqueueDbOp(dbPath, () => withDb(dbPath, async (conn) => {
    const cond = opts.includeDeleted ? 'true' : 'r.deleted_time IS NULL';
    if (opts.nodeId) {
      const rows = await execBound(conn,
        `MATCH (a:Node)-[r:Rel]->(b:Node) WHERE ${cond} AND (a.id = $nodeId OR b.id = $nodeId)
         RETURN r.*, a.id AS from_id, b.id AS to_id`,
        { nodeId: opts.nodeId });
      return rows.map(rowToRel);
    }
    const rows = await queryAll(conn,
      `MATCH (a:Node)-[r:Rel]->(b:Node) WHERE ${cond}
       RETURN r.*, a.id AS from_id, b.id AS to_id`);
    return rows.map(rowToRel);
  }));
}

export async function createRel(dbPath: string, input: RelInput): Promise<RelRecord> {
  await ensureSchema(dbPath);
  return enqueueDbOp(dbPath, () => withRetry(() => withDb(dbPath, async (conn) => {
    if (input.from === input.to) throw new KgError('不支持自环关系（from === to）');
    // 校验两端点存在且未软删
    const cnt = await execBound(conn,
      `MATCH (n:Node) WHERE n.id IN [$from, $to] AND n.deleted_time IS NULL RETURN count(n) AS c`,
      { from: input.from, to: input.to });
    if (Number(cnt[0]['c']) < 2) {
      throw new KgError(`关系端点不存在或已删除: ${input.from} -> ${input.to}`);
    }
    const id = relIdOf(input.from, input.to, input.type);
    // 确定性 id 的幂等保护：同端点同 type 的未删关系已存在则拒绝。
    // 已软删的同 id 行不阻止——重建是新行，删痕保留（includeDeleted 可见两条）。
    const dup = await execBound(conn,
      `MATCH ()-[r:Rel {id: $id}]->() WHERE r.deleted_time IS NULL RETURN count(r) AS c`, { id });
    if (Number(dup[0]['c']) > 0) {
      throw new KgError(`关系已存在: ${input.type} ${input.from} -> ${input.to}`);
    }
    const keys = attrKeys(input.attrs);
    if (keys.length) await ensureAttrColumns(conn, 'Rel', input.attrs!);
    const attrCols = keys.map((k) => `${k}: $a_${k}`).join(', ');
    const attrParams: Record<string, unknown> = {};
    for (const k of keys) attrParams[`a_${k}`] = input.attrs![k];
    const nowStr = tsParam(new Date())!;
    // 实测：REL CREATE 属性映射与 SET 一样不接受 STRING→TIMESTAMP 隐式转换，须 timestamp() 包一层
    await execBound(conn, `MATCH (a:Node {id: $from}), (b:Node {id: $to})
      CREATE (a)-[:Rel {id: $id, type: $type, description: $descr,
        created_time: timestamp($ct), updated_time: timestamp($ut), deleted_time: NULL, is_deprecate: $dep${attrCols ? `, ${attrCols}` : ''}}]->(b)`, {
      from: input.from, to: input.to, id, type: input.type,
      descr: input.description ?? '', ct: nowStr, ut: nowStr,
      dep: input.is_deprecate ?? false, ...attrParams,
    });
    // 写后断言：MATCH 零命中时 CREATE 是静默 no-op（实测），回查防幻象成功。
    // 同 id 已软删行可并存，只断言未删行数恰为 1。
    const back = await execBound(conn,
      `MATCH ()-[r:Rel {id: $id}]->() WHERE r.deleted_time IS NULL RETURN count(r) AS c`, { id });
    if (Number(back[0]['c']) !== 1) throw new KgError('关系创建失败：端点不存在或已删除');
    const rows = await execBound(conn,
      `MATCH (a:Node)-[r:Rel {id: $id}]->(b:Node) WHERE r.deleted_time IS NULL
       RETURN r.*, a.id AS from_id, b.id AS to_id`, { id });
    return rowToRel(rows[0]);
  })));
}

export async function updateRel(
  dbPath: string,
  id: string,
  patch: Partial<Omit<RelInput, 'from' | 'to'>>,
): Promise<RelRecord> {
  await ensureSchema(dbPath);
  return enqueueDbOp(dbPath, () => withRetry(() => withDb(dbPath, async (conn) => {
    const nowStr = tsParam(new Date())!;
    // 实测：SET 的 TIMESTAMP 列不接受 STRING 参数，须 timestamp($ut) 包一层
    const sets: string[] = ['r.updated_time = timestamp($ut)'];
    const params: Record<string, unknown> = { id, ut: nowStr };
    if (patch.type !== undefined) { sets.push('r.type = $type'); params.type = patch.type; }
    if (patch.description !== undefined) { sets.push('r.description = $descr'); params.descr = patch.description; }
    if (patch.is_deprecate !== undefined) { sets.push('r.is_deprecate = $dep'); params.dep = patch.is_deprecate; }
    if (patch.attrs !== undefined) {
      const keys = attrKeys(patch.attrs);
      if (keys.length) {
        await ensureAttrColumns(conn, 'Rel', patch.attrs!);
        // 只 SET 提交的 key：未提交的动态列原值保留（不删除动态列）
        for (const k of keys) { sets.push(`r.${k} = $a_${k}`); params[`a_${k}`] = patch.attrs![k]; }
      }
    }
    await execBound(conn,
      `MATCH ()-[r:Rel {id: $id}]->() WHERE r.deleted_time IS NULL SET ${sets.join(', ')}`, params);
    // 写后断言：零命中 SET 是静默 no-op（实测），回查防幻象成功
    const rows = await execBound(conn,
      `MATCH (a:Node)-[r:Rel {id: $id}]->(b:Node) WHERE r.deleted_time IS NULL
       RETURN r.*, a.id AS from_id, b.id AS to_id`, { id });
    if (!rows.length) throw new KgError(`关系不存在: ${id}`);
    return rowToRel(rows[0]);
  })));
}

export async function deleteRel(dbPath: string, id: string): Promise<void> {
  await ensureSchema(dbPath);
  await enqueueDbOp(dbPath, () => withRetry(() => withDb(dbPath, async (conn) => {
    // 契约：不存在（含已软删）须抛错，与 deleteNode 一致
    const cur = await execBound(conn,
      `MATCH ()-[r:Rel {id: $id}]->() WHERE r.deleted_time IS NULL RETURN count(r) AS c`, { id });
    if (Number(cur[0]['c']) === 0) throw new KgError(`关系不存在: ${id}`);
    const nowStr = tsParam(new Date())!;
    await execBound(conn,
      `MATCH ()-[r:Rel {id: $id}]->() WHERE r.deleted_time IS NULL SET r.deleted_time = timestamp($now)`,
      { id, now: nowStr });
  })));
}

/** 还原软删关系：deleted_time 置 NULL。
 * 端点节点若软删 → 先逐个 restoreNode（先节点后关系；name 冲突等错误向上抛，边保持软删）。
 * 不存在 → KgError('关系不存在: id')；未删 → 幂等直接返回该行。
 * 同 id 多条软删行（歧义）→ KgError('关系存在多条软删记录，无法自动恢复，请手动重建')。
 *
 * 编排而非单队列任务：restoreNode 自身会 enqueueDbOp，若本函数整体入队，
 * 队列任务内再入队会互相等待死锁。故分三段各自独立入队：
 * A 只读查态 → B 软删端点逐个 restoreNode → C 终态判定 + 写入（B 的级联可能已还原本边，C 幂等兜住）。 */
export async function restoreRel(dbPath: string, id: string): Promise<RelRecord> {
  await ensureSchema(dbPath);
  // 步骤 A：只读查询本 id 全部行（同 id 行端点相同：id 由 (from,to,type) 确定性生成）+ 端点存活态
  const rows = await enqueueDbOp(dbPath, () => withDb(dbPath, async (conn) =>
    execBound(conn,
      `MATCH (a:Node)-[r:Rel {id: $id}]->(b:Node)
       RETURN r.deleted_time AS rdt, a.id AS aid, a.deleted_time AS adt, b.id AS bid, b.deleted_time AS bdt`,
      { id })));
  if (!rows.length) throw new KgError(`关系不存在: ${id}`);
  // 未删行判定优先于歧义：未删 + 多条删痕并存时幂等返回活行（步骤 C）
  const hasLive = rows.some((row) => row['rdt'] === null || row['rdt'] === undefined);
  if (!hasLive && rows.length > 1) {
    throw new KgError('关系存在多条软删记录，无法自动恢复，请手动重建');
  }
  // 步骤 B：软删端点先还原（未删边的端点必然未删——deleteNode 级联软删其全部未删边，故 hasLive 时跳过）。
  // restoreNode 失败（如 name 冲突）向上抛，本边保持软删；其级联可能已还原本边（对端活 + 无未删行 + 软删恰 1）。
  if (!hasLive) {
    if (rows[0]['adt'] !== null && rows[0]['adt'] !== undefined) {
      await restoreNode(dbPath, String(rows[0]['aid']));
    }
    if (rows[0]['bdt'] !== null && rows[0]['bdt'] !== undefined) {
      await restoreNode(dbPath, String(rows[0]['bid']));
    }
  }
  // 步骤 C：终态判定 + 写入；级联已还原（未删）→ 幂等直接返回。
  // SET 守卫端点存活：B→C 间隙并发 deleteNode 会级联把边打回软删且端点已删 —
  // 端点条件使 SET 零命中，回查断言抛错，边保持软删（不复活悬空边）。
  return enqueueDbOp(dbPath, () => withRetry(() => withDb(dbPath, async (conn) => {
    const cur = await execBound(conn,
      `MATCH ()-[r:Rel {id: $id}]->() RETURN r.deleted_time AS rdt`, { id });
    if (!cur.length) throw new KgError(`关系不存在: ${id}`);
    if (!cur.some((row) => row['rdt'] === null || row['rdt'] === undefined)) {
      if (cur.length > 1) throw new KgError('关系存在多条软删记录，无法自动恢复，请手动重建');
      await execBound(conn,
        `MATCH (a:Node)-[r:Rel {id: $id}]->(b:Node)
         WHERE r.deleted_time IS NOT NULL AND a.deleted_time IS NULL AND b.deleted_time IS NULL
         SET r.deleted_time = NULL`, { id });
    }
    // 写后回查断言：未删行恰 1，防幻象成功
    const back = await execBound(conn,
      `MATCH (a:Node)-[r:Rel {id: $id}]->(b:Node) WHERE r.deleted_time IS NULL
       RETURN r.*, a.id AS from_id, b.id AS to_id`, { id });
    if (back.length !== 1) throw new KgError(`关系还原失败: ${id}`);
    return rowToRel(back[0]);
  })));
}

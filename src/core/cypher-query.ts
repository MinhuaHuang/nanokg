import { withDb, collect } from './db.js';
import { ensureSchema } from './schema.js';
import { enqueueDbOp } from './serialize.js';

export interface CypherResult {
  columns: string[];
  rows: unknown[][];
}

/**
 * 执行 Cypher 查询。
 * 实测（@ladybugdb/core 0.20.1）：
 * - conn.query 对语法错误直接抛 Parser exception，无需额外检查；
 * - 空结果仍有列名（getColumnNames），无 RETURN 的写语句列名与行均为空；
 * - 多语句只取首个结果（与 queryAll/collect 行为一致）。
 */
export async function queryCypher(dbPath: string, cypher: string): Promise<CypherResult> {
  await ensureSchema(dbPath);
  return enqueueDbOp(dbPath, () => withDb(dbPath, async (conn) => {
    const res = await conn.query(cypher);
    const first = Array.isArray(res) ? res[0] : res;
    // 列名取自结果元数据（须在 collect close 前读取），保证列序与空结果列名
    const columns = await first.getColumnNames();
    const rows = await collect(res);
    return { columns, rows: rows.map((r) => columns.map((c) => r[c])) };
  }));
}

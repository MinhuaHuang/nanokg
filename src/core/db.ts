import { Database, Connection, QueryResult, LbugValue } from '@ladybugdb/core';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 收集查询结果行，并释放全部结果持有的锁。
 * 实测：每个 QueryResult 持有数据库文件锁，不 close 会导致同路径
 * 重新打开数据库时报 "Could not set lock on file (Error: 33)"。
 */
export async function collect(
  res: QueryResult | QueryResult[],
): Promise<Record<string, LbugValue>[]> {
  const results = Array.isArray(res) ? res : [res];
  try {
    return await results[0].getAll();
  } finally {
    for (const r of results) {
      try { r.close(); } catch { /* ignore */ }
    }
  }
}

/** 执行单条语句，返回首个结果的全部行（结果自动 close，防文件锁泄漏）。 */
export async function queryAll(
  conn: Connection,
  sql: string,
): Promise<Record<string, LbugValue>[]> {
  return collect(await conn.query(sql));
}

/**
 * 参数绑定执行：用户输入值一律走这里（零转义面）。返回行数组。
 *
 * 实测（@ladybugdb/core 0.20.1）：
 * - SQL 内用 $name 占位符，但 params 对象的键名**不带 $ 前缀**（{ name: v }），
 *   带 $ 前缀会报 "Parameter name not found"。
 * - prepare() 对非法 SQL 不抛错，而是 resolve 一个 isSuccess()===false 的对象，
 *   错误信息在 getErrorMessage()，须显式检查。
 * - 参数名不能用保留字（如 $desc，DESC 为排序关键字），解析器直接报 Parser exception。
 * - SET / REL CREATE 的 TIMESTAMP 位置不接受 STRING 参数（无隐式转换），
 *   须写 timestamp($ts) 显式包一层。
 * - PreparedStatement 无 close 方法（见 lbug.d.ts），仅需释放 QueryResult（collect 内处理）。
 */
export async function execBound(
  conn: Connection,
  sql: string,
  params: Record<string, unknown>,
): Promise<Record<string, LbugValue>[]> {
  const ps = await conn.prepare(sql);
  if (!ps.isSuccess()) throw new Error(ps.getErrorMessage());
  return collect(await conn.execute(ps, params as Record<string, LbugValue>));
}

export async function withDb<T>(
  dbPath: string,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  let conn: Connection;
  try {
    conn = new Connection(db);
  } catch (e) {
    try { db.closeSync(); } catch { /* ignore */ }
    throw e;
  }
  try {
    return await fn(conn);
  } finally {
    // 实测：close() 返回 Promise（异步）；同步清理需用 closeSync()
    try { conn.closeSync(); } catch { /* ignore */ }
    try { db.closeSync(); } catch { /* ignore */ }
  }
}

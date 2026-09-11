import type { Connection } from '@ladybugdb/core';
import { queryAll } from './db.js';
import { KgError } from './errors.js';

/** Node 系统字段（不允许作为动态属性名） */
export const NODE_SYSTEM_COLS = new Set([
  'id', 'name', 'type', 'description',
  'created_time', 'updated_time', 'deleted_time', 'is_deprecate',
]);

/** Rel 系统字段（不允许作为动态属性名） */
export const REL_SYSTEM_COLS = new Set([
  'id', 'type', 'description',
  'created_time', 'updated_time', 'deleted_time', 'is_deprecate',
]);

/**
 * 反射表全部属性列。
 *
 * 探针结论（@ladybugdb/core 0.20.1，2026-09-01 实测）：
 * - DESCRIBE 全语法不可用：`DESCRIBE [NODE TABLE] <t>` 报 Parser exception
 *   （DESCRIBE 不在文法内）；`CALL DESCRIBE_TABLE('Node')` 报 function 不存在。
 * - 可用反射：`CALL TABLE_INFO('<table>') RETURN *`（CALL 必须带 RETURN，
 *   否则报 "Only standalone table functions can be called without return statement"）。
 *   返回行列名：`property id` / `name`（属性名）/ `type` / `default expression` /
 *   `primary key`（Node 表）或 `storage_direction`（Rel 表）。
 *   Rel 表不列 FROM/TO（从 property id 1 的 id 列开始），无需过滤端点。
 * - `ALTER TABLE <T> ADD <col> STRING` 后旧行新列读回 NULL，TABLE_INFO 即含新列。
 *
 * 结果不做进程缓存：withDb 生命周期短，每次反射保证准确（避免 ALTER 后读到陈旧列集）。
 */
export async function tableColumns(
  conn: Connection,
  table: 'Node' | 'Rel',
): Promise<Set<string>> {
  const rows = await queryAll(conn, `CALL TABLE_INFO('${table}') RETURN *`);
  return new Set(rows.map((r) => String(r['name'])));
}

/**
 * 属性名校验：列名仅允许 [A-Za-z0-9_]（防注入——列名无法参数绑定，只能静态拼接），
 * 且不得为系统字段——大小写折叠比对（Kùzu 列名不区分大小写，NAME 会撞系统列 name）；
 * 同一折叠名不得出现两种拼写（如 Foo 与 FOO——Kùzu 视为同列，ALTER 第二个才报
 * already has property，导入路径会迟至物理删除后才炸）。keys 允许多条目属性名合并
 * （同名重复合法，先 Set 折叠），仅大小写不同的拼写视为重复。
 * ensureAttrColumns 与导入预校验共用。
 */
export function assertAttrNames(table: 'Node' | 'Rel', keys: string[]): void {
  const sys = table === 'Node' ? NODE_SYSTEM_COLS : REL_SYSTEM_COLS;
  const sysLower = new Set([...sys].map((c) => c.toLowerCase()));
  const seen = new Map<string, string>();
  for (const k of new Set(keys)) {
    const lower = k.toLowerCase();
    if (!/^[A-Za-z0-9_]+$/.test(k) || sysLower.has(lower)) {
      throw new KgError(`非法属性名: ${k}`);
    }
    if (seen.has(lower)) throw new KgError(`属性名大小写重复: ${seen.get(lower)} 与 ${k}`);
    seen.set(lower, k);
  }
}

/**
 * 写入前保证 attrs 的 key 都有列：未知 key 自动 `ALTER TABLE ADD <col> STRING`。
 */
export async function ensureAttrColumns(
  conn: Connection,
  table: 'Node' | 'Rel',
  attrs: Record<string, string>,
): Promise<void> {
  const keys = Object.keys(attrs).filter((k) => k.length > 0);
  if (!keys.length) return;
  assertAttrNames(table, keys);
  const cols = await tableColumns(conn, table);
  // 已存列大小写折叠比对：Kùzu 列名不区分大小写，提交 FOO 撞已存列 foo 时
  // 显式报错（静默写入会让 attrs 键名与库列名不一致，读回时更困惑）
  const colLower = new Map([...cols].map((c) => [c.toLowerCase(), c]));
  for (const k of keys) {
    const existing = colLower.get(k.toLowerCase());
    if (existing !== undefined && existing !== k) {
      throw new KgError(`属性名 ${k} 与已有属性 ${existing} 大小写冲突`);
    }
  }
  const missing = keys.filter((k) => !cols.has(k));
  for (const col of missing) {
    await queryAll(conn, `ALTER TABLE ${table} ADD ${col} STRING`);
  }
}

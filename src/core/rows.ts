import type { NodeRecord, RelRecord } from './types.js';
import { toIsoTs } from './cypher.js';
import { NODE_SYSTEM_COLS, REL_SYSTEM_COLS } from './attrs.js';

/**
 * 拆分 `RETURN <v>.*` 形态的行（列名带变量前缀，如 n.id / n.owner）：
 * 系统列 → sys；其余列 → attrs（null 不进 attrs，非 null 一律 String(v)）。
 *
 * 探针结论（实测 0.20.1）：`RETURN n.*` 列名**非裸名**，带 `n.` 前缀；
 * 动态列（ALTER ADD）自动包含在 n.* 中，无需显式列清单。
 */
function splitRow(
  r: Record<string, unknown>,
  prefix: 'n.' | 'r.',
  sysCols: Set<string>,
): { sys: Record<string, unknown>; attrs: Record<string, string> } {
  const sys: Record<string, unknown> = {};
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    if (!k.startsWith(prefix)) continue;
    const col = k.slice(prefix.length);
    if (sysCols.has(col)) sys[col] = v;
    else if (v !== null && v !== undefined) attrs[col] = String(v);
  }
  return { sys, attrs };
}

/** 查询列形态：RETURN n.*（含动态列） */
export function rowToNode(r: Record<string, unknown>): NodeRecord {
  const { sys, attrs } = splitRow(r, 'n.', NODE_SYSTEM_COLS);
  return {
    id: sys.id as string,
    name: sys.name as string,
    type: (sys.type as string) ?? '',
    description: (sys.description as string) ?? '',
    attrs,
    created_time: toIsoTs(sys.created_time)!,
    updated_time: toIsoTs(sys.updated_time)!,
    deleted_time: toIsoTs(sys.deleted_time),
    is_deprecate: Boolean(sys.is_deprecate),
  };
}

/** 查询列形态：RETURN r.*, a.id AS from_id, b.id AS to_id */
export function rowToRel(r: Record<string, unknown>): RelRecord {
  const { sys, attrs } = splitRow(r, 'r.', REL_SYSTEM_COLS);
  return {
    id: sys.id as string,
    type: sys.type as string,
    from: r['from_id'] as string,
    to: r['to_id'] as string,
    description: (sys.description as string) ?? '',
    attrs,
    created_time: toIsoTs(sys.created_time)!,
    updated_time: toIsoTs(sys.updated_time)!,
    deleted_time: toIsoTs(sys.deleted_time),
    is_deprecate: Boolean(sys.is_deprecate),
  };
}

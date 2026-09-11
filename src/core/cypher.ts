/** Cypher 字符串字面量：转义反斜杠与单引号 */
export function cyStr(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** JS 值 → Cypher 字面量（string/boolean/number/null/其他 JSON 序列化为字符串） */
export function cyVal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return cyStr(typeof v === 'string' ? v : JSON.stringify(v));
}

/** Date → Cypher timestamp() 字面量（UTC，秒精度） */
export function cyTs(d: Date | null): string {
  if (!d) return 'NULL';
  return `timestamp('${tsParam(d)}')`;
}

/** Date → 'YYYY-MM-DD HH:mm:ss' 字符串（用于参数绑定 TIMESTAMP 列；禁止绑 Date 对象——驱动会截断时分秒） */
export function tsParam(d: Date | null): string | null {
  if (!d) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** DB 返回的时间值（Date）→ ISO 字符串或 null */
export function toIsoTs(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return new Date(v as string | Date).toISOString();
}

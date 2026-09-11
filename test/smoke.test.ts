import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDb, queryAll, collect } from '../src/core/db.js';

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'nanokg-')), 'test.lbug');
}

describe('LadybugDB API 冒烟', () => {
  it('query + getAll 返回行', async () => {
    const p = tmpDb();
    const rows = await withDb(p, (conn) => queryAll(conn, 'RETURN 1 AS n'));
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('建表 / 插入 / 查询 / TIMESTAMP / NULL / 物理删除', async () => {
    const p = tmpDb();
    await withDb(p, async (conn) => {
      await queryAll(conn, `CREATE NODE TABLE T(
        id STRING PRIMARY KEY, ts TIMESTAMP, dt TIMESTAMP, flag BOOLEAN)`);
      await queryAll(conn, `CREATE (t:T {id: 'a', ts: timestamp('2026-08-31 08:00:00'), dt: NULL, flag: true})`);
      const got = await queryAll(conn, `MATCH (t:T) RETURN t.id, t.ts, t.dt, t.flag`);
      const row = got[0] as Record<string, unknown>;
      expect(row['t.id']).toBe('a');
      expect(row['t.flag']).toBe(true);
      expect(row['t.dt']).toBeNull();
      // 实测：TIMESTAMP 列返回 JS Date 对象（非字符串）
      expect(row['t.ts']).toBeInstanceOf(Date);
      expect((row['t.ts'] as Date).toISOString()).toBe('2026-08-31T08:00:00.000Z');
      await queryAll(conn, `MATCH (t:T {id: 'a'}) DELETE t`);
      const after = await queryAll(conn, `MATCH (t:T) RETURN count(t)`);
      const cnt = Object.values(after[0] as Record<string, unknown>)[0];
      expect(Number(cnt)).toBe(0);
    });
  });

  it('重复建表报错（幂等 schema 需 catch）', async () => {
    const p = tmpDb();
    await withDb(p, async (conn) => {
      await queryAll(conn, `CREATE NODE TABLE U(id STRING PRIMARY KEY)`);
      await expect(
        queryAll(conn, `CREATE NODE TABLE U(id STRING PRIMARY KEY)`),
      ).rejects.toThrow();
    });
  });

  it('跨 withDb 循环持久化（QueryResult 锁释放回归）', async () => {
    const p = tmpDb();
    // 循环 1：写入并关闭；若结果锁未释放，循环 2 首次 query 报 lock Error 33
    await withDb(p, async (conn) => {
      await queryAll(conn, `CREATE NODE TABLE P(id STRING PRIMARY KEY)`);
      await queryAll(conn, `CREATE (t:P {id: 'x'})`);
    });
    // 循环 2：同路径重新打开，读回验证
    await withDb(p, async (conn) => {
      const rows = await queryAll(conn, `MATCH (t:P) RETURN t.id`);
      expect(rows).toEqual([{ 't.id': 'x' }]);
    });
  });

  it('prepare/execute 参数绑定：string/number/boolean/null/字符串时间戳', async () => {
    const p = tmpDb();
    await withDb(p, async (conn) => {
      await queryAll(conn, `CREATE NODE TABLE B(
        id STRING PRIMARY KEY, name STRING, n INT64, flag BOOLEAN, opt STRING, ts TIMESTAMP)`);
      // $name 占位符；execute 返回 QueryResult（含写操作），同样必须 close
      const ins = await conn.prepare(
        `CREATE (b:B {id: $id, name: $name, n: $n, flag: $flag, opt: $opt, ts: $ts})`,
      );
      await collect(await conn.execute(ins, {
        id: 'b1', name: "O'Brien", n: 42, flag: true, opt: null,
        ts: '2026-08-31 08:00:00',
      }));
      const rows = await queryAll(conn, `MATCH (b:B) RETURN b.name, b.n, b.flag, b.opt, b.ts`);
      const row = rows[0] as Record<string, unknown>;
      expect(row['b.name']).toBe("O'Brien");
      expect(row['b.n']).toBe(42);
      expect(row['b.flag']).toBe(true);
      expect(row['b.opt']).toBeNull();
      // 字符串 'YYYY-MM-DD HH:mm:ss' 绑定 TIMESTAMP 可行且保精度
      expect(row['b.ts']).toBeInstanceOf(Date);
      expect((row['b.ts'] as Date).toISOString()).toBe('2026-08-31T08:00:00.000Z');
    });
  });

  it('Date 对象直接绑定 TIMESTAMP 会截断时间（驱动限制，禁止使用）', async () => {
    const p = tmpDb();
    await withDb(p, async (conn) => {
      await queryAll(conn, `CREATE NODE TABLE D(id STRING PRIMARY KEY, ts TIMESTAMP)`);
      const ps = await conn.prepare(`CREATE (t:D {id: $id, ts: $ts})`);
      await collect(await conn.execute(ps, {
        id: 'd1',
        ts: new Date('2026-08-31T20:30:15.123Z'),
      }));
      const rows = await queryAll(conn, `MATCH (t:D) RETURN t.ts`);
      // 实测 @ladybugdb/core 0.20.1：Date 绑定 TIMESTAMP 仅保留日期部分，
      // 时分秒静默清零（20:30:15.123Z 读回 00:00:00.000Z）。
      // 若此断言在未来驱动版本失败，说明该限制已修复，可重估绑定策略。
      expect((rows[0]['t.ts'] as Date).toISOString()).toBe('2026-08-31T00:00:00.000Z');
    });
  });
});

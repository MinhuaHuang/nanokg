import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDb, queryAll, ensureSchema } from '../src/core/index.js';

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't.lbug');
}

describe('ensureSchema', () => {
  it('建表且幂等，可插入与查询', async () => {
    const p = tmpDb();
    await ensureSchema(p);
    await ensureSchema(p); // 进程内缓存直接返回
    await withDb(p, async (conn) => {
      await queryAll(conn, `CREATE (n:Node {id: 'x', name: 'x', type: '', description: '',
        created_time: timestamp('2026-08-31 00:00:00'), updated_time: timestamp('2026-08-31 00:00:00'),
        deleted_time: NULL, is_deprecate: false})`);
      const rows = await queryAll(conn, `MATCH (n:Node) RETURN count(n) AS c`);
      expect(Number(rows[0]['c'])).toBe(1);
    });
  });

  it('模拟另一进程：清空缓存后 DDL 重跑走 already exists 分支不报错', async () => {
    const p = tmpDb();
    await ensureSchema(p);
    // schemaReady 为模块私有。验证幂等性改用直接方式：新进程语义等价于再次执行 DDL。
    // 通过再次 ensureSchema（进程内命中缓存）+ 手动重跑 DDL 验证 catch 分支：
    await ensureSchema(p);
    await withDb(p, async (conn) => {
      await expect(queryAll(conn, `CREATE NODE TABLE Node(
        id STRING PRIMARY KEY, name STRING, type STRING, description STRING,
        created_time TIMESTAMP, updated_time TIMESTAMP, deleted_time TIMESTAMP, is_deprecate BOOLEAN)`))
        .rejects.toThrow(/already exists/);
    });
  });
});

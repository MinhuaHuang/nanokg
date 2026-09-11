import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSchema, withDb, queryAll, cyStr } from '../src/core/index.js';

const BS = String.fromCharCode(92); // 反斜杠，避免源码转义歧义

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't.lbug');
}

describe('cyStr 转义往返（字面量路径回归）', () => {
  it.each([
    "O'Brien",
    'back' + BS + 'slash',
    'C:' + BS + BS + 'p' + BS + 'f',
    "x'}) RETURN 999 //",
    '中文"引号"',
  ])('%s 往返无损', async (s) => {
    const p = tmpDb();
    await ensureSchema(p);
    await withDb(p, async (conn) => {
      await queryAll(conn, `CREATE (n:Node {id: 't', name: ${cyStr(s)}, type: '', description: '',
        created_time: timestamp('2026-08-31 00:00:00'), updated_time: timestamp('2026-08-31 00:00:00'),
        deleted_time: NULL, is_deprecate: false})`);
      const rows = await queryAll(conn, `MATCH (n:Node) RETURN n.name AS name`);
      expect(rows[0]['name']).toBe(s);
    });
  });
});

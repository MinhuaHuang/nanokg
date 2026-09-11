import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSchema, createNode, queryCypher } from '../src/core/index.js';

let dbPath: string;
beforeEach(async () => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't.lbug');
  await ensureSchema(dbPath);
  await createNode(dbPath, { name: 'Alice' });
});

describe('queryCypher', () => {
  it('读查询：columns + rows（表格形式）', async () => {
    const r = await queryCypher(dbPath, 'MATCH (n:Node) RETURN n.name AS name, n.id AS id');
    expect(r.columns).toEqual(['name', 'id']);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0][0]).toBe('Alice');
    expect(typeof r.rows[0][1]).toBe('string');
  });

  it('写查询透传：CREATE 生效', async () => {
    await queryCypher(dbPath, `CREATE (n:Node {id: 'x', name: 'X', type: '', description: '',
      created_time: timestamp('2026-08-31 00:00:00'), updated_time: timestamp('2026-08-31 00:00:00'),
      deleted_time: NULL, is_deprecate: false})`);
    const r = await queryCypher(dbPath, 'MATCH (n:Node) RETURN count(n) AS c');
    expect(Number(r.rows[0][0])).toBe(2);
  });

  it('语法错误：抛出含信息的错误', async () => {
    await expect(queryCypher(dbPath, 'MATCHH (n)')).rejects.toThrow();
  });

  it('空结果：有列名无行（实测 getColumnNames 元数据）', async () => {
    const r = await queryCypher(dbPath, 'MATCH (n:Node {id: "nope"}) RETURN n.name AS name');
    expect(r.columns).toEqual(['name']);
    expect(r.rows).toEqual([]);
  });
});

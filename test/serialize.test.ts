import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSchema, createNode, listNodes } from '../src/core/index.js';

let dbPath: string;
beforeEach(async () => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't.lbug');
  await ensureSchema(dbPath);
});

describe('per-dbPath DB 操作队列', () => {
  it('并发同名 createNode 恰好一个成功（无重名）', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => createNode(dbPath, { name: 'Same' })),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBe(1);
    expect((await listNodes(dbPath, {})).length).toBe(1);
  });

  it('不同名并发全部成功', async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => createNode(dbPath, { name: `N${i}` })));
    expect((await listNodes(dbPath, {})).length).toBe(5);
  });

  it('读写混合并发全部成功（无文件锁错误）', async () => {
    // 队列化前：读（每次 withDb 新开 Database）与写重叠报 Could not set lock（Error 33）
    const results = await Promise.all([
      createNode(dbPath, { name: 'W' }),
      ...Array(10).fill(0).map(() => listNodes(dbPath, {})),
    ]);
    expect(results[0].name).toBe('W');
    for (const rows of results.slice(1)) expect(Array.isArray(rows)).toBe(true);
    expect((await listNodes(dbPath, {})).length).toBe(1);
  });
});

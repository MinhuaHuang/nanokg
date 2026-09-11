import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureSchema, createNode, deleteNode, listRels, createRel, updateRel, deleteRel, restoreRel,
  getNode, listNodes, relIdOf, KgError,
} from '../src/core/index.js';

let dbPath: string;
let a: string; let b: string; let c: string;
beforeEach(async () => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't.lbug');
  await ensureSchema(dbPath);
  a = (await createNode(dbPath, { name: 'A' })).id;
  b = (await createNode(dbPath, { name: 'B' })).id;
  c = (await createNode(dbPath, { name: 'C' })).id;
});

describe('rels', () => {
  it('create + listByNode（双向过滤）+ id === relIdOf + attrs', async () => {
    const r = await createRel(dbPath, {
      type: 'knows', from: a, to: b, attrs: { since: '2020', weight: '5' },
    });
    expect(r.id).toBe(relIdOf(a, b, 'knows'));
    expect(r.type).toBe('knows');
    expect(r.attrs).toEqual({ since: '2020', weight: '5' });
    expect((await listRels(dbPath, { nodeId: a }))[0].attrs).toEqual({ since: '2020', weight: '5' });
    expect((await listRels(dbPath, { nodeId: a })).length).toBe(1);
    expect((await listRels(dbPath, { nodeId: b })).length).toBe(1); // 反向也算
    expect((await listRels(dbPath, { nodeId: c })).length).toBe(0);
  });

  it('同端点同 type 重复 createRel 报已存在（确定性 id 幂等保护）', async () => {
    await createRel(dbPath, { type: 'knows', from: a, to: b });
    await expect(createRel(dbPath, { type: 'knows', from: a, to: b }))
      .rejects.toThrow(/关系已存在: knows/);
    // 不同 type / 不同方向是不同关系，可建
    await createRel(dbPath, { type: 'owns', from: a, to: b });
    await createRel(dbPath, { type: 'knows', from: b, to: a });
    expect((await listRels(dbPath, {})).length).toBe(3);
  });

  it('软删后同 id 可重建：未删 1 条，历史删痕保留', async () => {
    const r = await createRel(dbPath, { type: 'knows', from: a, to: b });
    await deleteRel(dbPath, r.id);
    const r2 = await createRel(dbPath, { type: 'knows', from: a, to: b });
    expect(r2.id).toBe(r.id); // 确定性 id：同端点同 type 重建后 id 不变
    expect((await listRels(dbPath, {})).length).toBe(1);
    const all = await listRels(dbPath, { includeDeleted: true });
    expect(all.length).toBe(2); // 删痕 + 新行
    expect(all.filter((x) => x.deleted_time).length).toBe(1);
  });

  it('create 校验端点存在且未软删', async () => {
    await expect(createRel(dbPath, { type: 'x', from: a, to: 'ghost' })).rejects.toThrow(KgError);
  });

  it('create 端点已软删拒绝建边', async () => {
    await deleteNode(dbPath, a);
    await expect(createRel(dbPath, { type: 'x', from: a, to: b })).rejects.toThrow(KgError);
  });

  it('create 自环（from===to）显式拒绝', async () => {
    await expect(createRel(dbPath, { type: 'self', from: a, to: a })).rejects.toThrow(/自环/);
  });

  it('type 含单引号往返无损', async () => {
    const r = await createRel(dbPath, { type: "owner's", from: a, to: b });
    const got = await listRels(dbPath, { nodeId: a });
    expect(got.find((x) => x.id === r.id)?.type).toBe("owner's");
  });

  it('update：改 type/description/attrs/is_deprecate + updated_time 变化 + 动态列保留', async () => {
    const r = await createRel(dbPath, { type: 'knows', from: a, to: b, attrs: { w: '1', tag: 't' } });
    await new Promise((res) => setTimeout(res, 1100)); // DB 时间戳秒精度，须跨秒才可严格比较
    const u = await updateRel(dbPath, r.id, {
      type: 'likes', description: 'd', attrs: { w: '9', extra: 'e' }, is_deprecate: true,
    });
    expect(u.type).toBe('likes');
    expect(u.description).toBe('d');
    expect(u.attrs).toEqual({ w: '9', tag: 't', extra: 'e' }); // 未提交的 tag 保留
    expect(u.is_deprecate).toBe(true);
    expect(u.updated_time > r.updated_time).toBe(true);
  });

  it('update attrs 非法属性名报错', async () => {
    const r = await createRel(dbPath, { type: 'knows', from: a, to: b });
    await expect(updateRel(dbPath, r.id, { attrs: { 'bad key': 'x' } })).rejects.toThrow(/非法属性名/);
    await expect(updateRel(dbPath, r.id, { attrs: { id: 'x' } })).rejects.toThrow(/非法属性名/);
  });

  it('update 不存在抛错', async () => {
    await expect(updateRel(dbPath, 'ghost', { type: 'x' })).rejects.toThrow(/不存在/);
  });

  it('delete：软删，默认过滤，includeDeleted 可见', async () => {
    const r = await createRel(dbPath, { type: 'knows', from: a, to: b });
    await deleteRel(dbPath, r.id);
    expect((await listRels(dbPath, {})).length).toBe(0);
    const all = await listRels(dbPath, { includeDeleted: true });
    expect(all.length).toBe(1);
    expect(all[0].deleted_time).toBeTruthy();
  });

  it('delete 不存在抛错（含已删）', async () => {
    const r = await createRel(dbPath, { type: 'knows', from: a, to: b });
    await deleteRel(dbPath, r.id);
    await expect(deleteRel(dbPath, r.id)).rejects.toThrow(/不存在/); // 二次删
    await expect(deleteRel(dbPath, 'ghost')).rejects.toThrow(/不存在/);
  });

  it('listRels 返回 from/to 节点 id', async () => {
    await createRel(dbPath, { type: 'knows', from: a, to: b });
    const rs = await listRels(dbPath, {});
    expect(rs[0].from).toBe(a);
    expect(rs[0].to).toBe(b);
  });
});

describe('restoreRel', () => {
  it('纯边恢复（端点都活）：软删边还原 + 默认 listRels 可见', async () => {
    const r = await createRel(dbPath, { type: 'knows', from: a, to: b });
    await deleteRel(dbPath, r.id);
    const restored = await restoreRel(dbPath, r.id);
    expect(restored.id).toBe(r.id);
    expect(restored.deleted_time).toBeNull();
    expect((await listRels(dbPath, {})).length).toBe(1);
  });

  it('端点级联：A、B 与边均软删 → 先恢复节点再恢复边', async () => {
    const r = await createRel(dbPath, { type: 'knows', from: a, to: b });
    await deleteNode(dbPath, a); // 边随 A 级联软删
    await deleteNode(dbPath, b);
    const restored = await restoreRel(dbPath, r.id);
    expect(restored.deleted_time).toBeNull();
    expect((await listNodes(dbPath, {})).length).toBe(3); // A、B 一并复活（先节点后关系）
    expect((await listRels(dbPath, {})).length).toBe(1);  // 边复活，默认可见
  });

  it('一端软删一端活：只恢复软删端 + 边', async () => {
    const r = await createRel(dbPath, { type: 'knows', from: a, to: b });
    await deleteNode(dbPath, b); // 边随 B 级联软删，A 未动
    const restored = await restoreRel(dbPath, r.id);
    expect(restored.deleted_time).toBeNull();
    expect((await getNode(dbPath, b))!.deleted_time).toBeNull(); // 软删端复活
    expect((await listRels(dbPath, {})).length).toBe(1);
  });

  it('不存在 → KgError；未删 → 幂等返回不报错', async () => {
    await expect(restoreRel(dbPath, 'ghost')).rejects.toThrow(/关系不存在/);
    const r = await createRel(dbPath, { type: 'knows', from: a, to: b });
    const again = await restoreRel(dbPath, r.id); // 未删幂等
    expect(again.id).toBe(r.id);
    expect(again.deleted_time).toBeNull();
    expect((await listRels(dbPath, {})).length).toBe(1);
  });

  it('端点 name 冲突：还原失败向上抛，边与节点保持软删', async () => {
    const r = await createRel(dbPath, { type: 'knows', from: a, to: b });
    await deleteNode(dbPath, a); // 边随 A 级联软删
    await createNode(dbPath, { name: 'A' }); // 同名重建占位
    await expect(restoreRel(dbPath, r.id)).rejects.toThrow(/已存在/); // 节点还原失败
    expect((await getNode(dbPath, a))!.deleted_time).toBeTruthy(); // A 保持软删
    expect((await listRels(dbPath, {})).length).toBe(0);           // 边保持软删
    const all = await listRels(dbPath, { includeDeleted: true });
    expect(all.filter((x) => x.deleted_time).length).toBe(1);
  });

  it('同 id 双软删行（软删→重建→再软删）歧义 → KgError，删痕保留', async () => {
    const r = await createRel(dbPath, { type: 'knows', from: a, to: b });
    await deleteRel(dbPath, r.id);                                   // 旧边软删
    await createRel(dbPath, { type: 'knows', from: a, to: b });      // 同 id 重建
    await deleteRel(dbPath, r.id);                                   // 再软删 → 2 条软删行
    await expect(restoreRel(dbPath, r.id)).rejects.toThrow(/无法自动恢复/);
    expect((await listRels(dbPath, { includeDeleted: true })).length).toBe(2); // 删痕保留
  });

  it('B/C 间隙并发删除端点 → 不复活悬空边（C 写入守卫端点存活）', async () => {
    // A、B、边均软删，restoreRel 的 B 段恢复端点后、C 段写入前，
    // 队列 FIFO 插入的 deleteNode(b) 把边打回软删且 b 已删 —
    // C 的 SET 端点守卫零命中 → 断言抛错，边不得活。
    const r = await createRel(dbPath, { type: 'knows', from: a, to: b });
    await deleteNode(dbPath, a);
    await deleteNode(dbPath, b);
    const p = restoreRel(dbPath, r.id);          // A(查态) 入队后立即挂起等待
    const sneak = deleteNode(dbPath, b).then(() => undefined, () => undefined); // B 后 C 前插队（恢复后的 b 再删）
    await Promise.allSettled([p, sneak]);
    // 无论交错细节如何，终态不得出现「活边挂软删端点」：
    const liveRels = await listRels(dbPath, {});
    const bNode = await getNode(dbPath, b);
    const dangling = liveRels.length > 0 && bNode?.deleted_time;
    expect(dangling).toBeFalsy();
  });
});

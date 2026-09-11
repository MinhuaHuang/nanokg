import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureSchema, listNodes, listNodeTypes, getNode, createNode, updateNode, deleteNode, restoreNode,
  KgError,
} from '../src/core/index.js';

let dbPath: string;
beforeEach(async () => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't.lbug');
  await ensureSchema(dbPath);
});

/** uuid 形态（8-4-4-4-12 小写十六进制） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('nodes', () => {
  it('create + get：默认值填充 + id 为 uuid', async () => {
    const n = await createNode(dbPath, {
      name: 'Alice', type: '系统', description: '人', attrs: { owner: 'team A', env: 'prod' },
    });
    expect(n.id).toMatch(UUID_RE);
    expect(n.name).toBe('Alice');
    expect(n.type).toBe('系统');
    expect(n.attrs).toEqual({ owner: 'team A', env: 'prod' });
    expect(n.deleted_time).toBeNull();
    expect(n.is_deprecate).toBe(false);
    expect(n.created_time).toBe(n.updated_time);
    const got = await getNode(dbPath, n.id);
    expect(got?.name).toBe('Alice');
    expect(got?.type).toBe('系统');
    expect(got?.attrs).toEqual({ owner: 'team A', env: 'prod' });
    expect(got?.created_time).toBeTruthy();
  });

  it('未传 type/attrs 时默认空', async () => {
    const n = await createNode(dbPath, { name: 'Bare' });
    expect(n.type).toBe('');
    expect(n.attrs).toEqual({});
  });

  it('name 含单引号/反斜杜往返无损', async () => {
    const n = await createNode(dbPath, { name: "O'Brien \\ Co" });
    const got = await getNode(dbPath, n.id);
    expect(got?.name).toBe("O'Brien \\ Co");
  });

  it('name 唯一：与未删行冲突抛错；软删行不占名', async () => {
    const a = await createNode(dbPath, { name: 'A' });
    await expect(createNode(dbPath, { name: 'A' })).rejects.toThrow(/已存在/); // 与未删行冲突
    await deleteNode(dbPath, a.id);
    await expect(createNode(dbPath, { name: 'A' })).resolves.toBeTruthy(); // 软删后可重建
  });

  it('软删后同 name 重建：新 uuid，includeDeleted 两条同 name（1 软删）', async () => {
    const a1 = await createNode(dbPath, { name: 'A' });
    await deleteNode(dbPath, a1.id);
    const a2 = await createNode(dbPath, { name: 'A' });
    expect(a2.id).toMatch(UUID_RE);
    expect(a2.id).not.toBe(a1.id); // 新 uuid，非复活旧 id
    const named = (await listNodes(dbPath, { includeDeleted: true })).filter((n) => n.name === 'A');
    expect(named.length).toBe(2);
    expect(named.filter((n) => n.deleted_time).length).toBe(1); // 旧软删行保留痕迹
  });

  it('list：nameLike 模糊 + includeDeleted 过滤', async () => {
    const a = await createNode(dbPath, { name: 'Alice' });
    await createNode(dbPath, { name: 'Bob' });
    await createNode(dbPath, { name: 'Alison' });
    expect((await listNodes(dbPath, {})).length).toBe(3);
    expect((await listNodes(dbPath, { nameLike: 'Ali' })).map((n) => n.name)).toEqual(['Alice', 'Alison']);
    await deleteNode(dbPath, a.id);
    expect((await listNodes(dbPath, {})).length).toBe(2);
    const all = await listNodes(dbPath, { includeDeleted: true });
    expect(all.length).toBe(3);
    expect(all.find((n) => n.id === a.id)?.deleted_time).toBeTruthy();
  });

  it('list：includeDeprecate 默认含弃用；false 时排除', async () => {
    await createNode(dbPath, { name: 'A' });
    await createNode(dbPath, { name: 'B', is_deprecate: true });
    expect((await listNodes(dbPath, {})).length).toBe(2); // 默认含弃用
    expect((await listNodes(dbPath)).length).toBe(2);     // opts 缺省同样含
    expect((await listNodes(dbPath, { includeDeprecate: false })).map((n) => n.name))
      .toEqual(['A']);
  });

  it('list：type 精确过滤；type + nameLike 组合', async () => {
    await createNode(dbPath, { name: 'Alice', type: '系统' });
    await createNode(dbPath, { name: 'Alison', type: '接口' });
    await createNode(dbPath, { name: 'Bob', type: '系统' });
    expect((await listNodes(dbPath, { type: '系统' })).map((n) => n.name)).toEqual(['Alice', 'Bob']);
    expect((await listNodes(dbPath, { type: '系统', nameLike: 'Ali' })).map((n) => n.name))
      .toEqual(['Alice']);
    expect((await listNodes(dbPath, { type: '不存在' })).length).toBe(0);
  });

  it('listNodeTypes：未删节点 DISTINCT type，排除空串，字典序（弃用算，删除不算）', async () => {
    expect(await listNodeTypes(dbPath)).toEqual([]); // 空库
    await createNode(dbPath, { name: 'A', type: '系统' });
    await createNode(dbPath, { name: 'B', type: '接口', is_deprecate: true }); // 弃用节点的 type 算「库中存在」
    await createNode(dbPath, { name: 'C', type: '系统' });                     // 重复 type → DISTINCT
    await createNode(dbPath, { name: 'D' });                                   // 空 type 排除
    const gone = await createNode(dbPath, { name: 'E', type: '服务' });
    await deleteNode(dbPath, gone.id);                                         // 删除节点不算
    expect(await listNodeTypes(dbPath)).toEqual(['接口', '系统']);
  });

  it('list：includeDeleted + includeDeprecate 组合', async () => {
    const a = await createNode(dbPath, { name: 'A' });           // 存活
    await createNode(dbPath, { name: 'B', is_deprecate: true }); // 存活弃用
    const c = await createNode(dbPath, { name: 'C', is_deprecate: true });
    await deleteNode(dbPath, c.id);                              // 删除且弃用
    await deleteNode(dbPath, a.id);                              // 删除未弃用
    expect((await listNodes(dbPath, {})).map((n) => n.name)).toEqual(['B']); // 默认：不含删除、含弃用
    expect((await listNodes(dbPath, { includeDeleted: true, includeDeprecate: false }))
      .map((n) => n.name)).toEqual(['A']);
    expect((await listNodes(dbPath, { includeDeleted: true })).map((n) => n.name))
      .toEqual(['A', 'B', 'C']);
  });

  it('update：改字段/type/name 冲突检测/is_deprecate', async () => {
    const a = await createNode(dbPath, { name: 'A' });
    const b = await createNode(dbPath, { name: 'B' });
    const u = await updateNode(dbPath, a.id, { type: '接口', description: 'x', is_deprecate: true });
    expect(u.type).toBe('接口');
    expect(u.description).toBe('x');
    expect(u.is_deprecate).toBe(true);
    expect(u.updated_time >= a.updated_time).toBe(true);
    await expect(updateNode(dbPath, a.id, { name: 'B' })).rejects.toThrow(/已存在/); // 与未删行冲突
    const u2 = await updateNode(dbPath, b.id, { name: 'C' });
    expect(u2.name).toBe('C');
    // 改名不改 id：uuid 创建时生成，永不随改名变（痛点 1 回归锁）
    expect(u2.id).toBe(b.id);
    // 改名撞软删行的 name 不算冲突（唯一性仅限未删行）
    const d = await createNode(dbPath, { name: 'D' });
    await deleteNode(dbPath, d.id);
    const u3 = await updateNode(dbPath, b.id, { name: 'D' });
    expect(u3.name).toBe('D');
  });

  it('attrs：update 提交新 key 自动加列，未提交的动态列保留', async () => {
    const a = await createNode(dbPath, { name: 'A', attrs: { owner: 'oa', env: 'prod' } });
    // update 加新 key：自动 ALTER ADD 列
    const u = await updateNode(dbPath, a.id, { attrs: { owner: 'ob', region: 'cn' } });
    expect(u.attrs).toEqual({ owner: 'ob', env: 'prod', region: 'cn' });
    // 回查持久化
    const got = await getNode(dbPath, a.id);
    expect(got?.attrs).toEqual({ owner: 'ob', env: 'prod', region: 'cn' });
  });

  it('attrs：非法属性名（保留字/系统字段/特殊字符）报错', async () => {
    const a = await createNode(dbPath, { name: 'A' });
    await expect(createNode(dbPath, { name: 'B', attrs: { 'bad-key': 'x' } })).rejects.toThrow(KgError);
    await expect(createNode(dbPath, { name: 'C', attrs: { 'name; DETACH': 'x' } })).rejects.toThrow(/非法属性名/);
    // 系统字段不可作为动态属性（防 SET 越权写系统列）
    await expect(updateNode(dbPath, a.id, { attrs: { description: 'hack' } })).rejects.toThrow(/非法属性名/);
    await expect(updateNode(dbPath, a.id, { attrs: { created_time: 'hack' } })).rejects.toThrow(/非法属性名/);
    // 大小写折叠：Kùzu 列名不区分大小写，NAME 会撞系统列 name
    await expect(updateNode(dbPath, a.id, { attrs: { NAME: 'hack' } })).rejects.toThrow(/非法属性名/);
    // 条目内大小写重复：Foo 与 FOO 是同一列，ALTER 第二个才报错——须在校验段拦截
    await expect(createNode(dbPath, { name: 'D', attrs: { Foo: '1', FOO: '2' } })).rejects.toThrow(/大小写重复/);
    // 新属性名撞已存列的大小写变体：库里已有 foo，提交 FOO — 显式报错非静默写入
    await createNode(dbPath, { name: 'E', attrs: { foo: '1' } });
    await expect(createNode(dbPath, { name: 'F', attrs: { FOO: 'x' } })).rejects.toThrow(/大小写冲突/);
  });

  it('attrs：值为含引号/反斜杠的字符串往返无损', async () => {
    const v = "it's a \\ path";
    const a = await createNode(dbPath, { name: 'A', attrs: { note: v } });
    expect((await getNode(dbPath, a.id))?.attrs['note']).toBe(v);
    await updateNode(dbPath, a.id, { attrs: { note: "x'}) RETURN 999 //" } });
    expect((await getNode(dbPath, a.id))?.attrs['note']).toBe("x'}) RETURN 999 //");
  });

  it('delete：软删 + 级联软删关联边', async () => {
    const a = await createNode(dbPath, { name: 'A' });
    const b = await createNode(dbPath, { name: 'B' });
    const c = await createNode(dbPath, { name: 'C' });
    const { createRel, listRels } = await import('../src/core/index.js');
    await createRel(dbPath, { type: 'knows', from: a.id, to: b.id });
    await createRel(dbPath, { type: 'knows', from: c.id, to: b.id });
    await deleteNode(dbPath, a.id);
    expect((await listRels(dbPath, {})).length).toBe(1);      // A 的边被级联软删
    expect((await listRels(dbPath, { includeDeleted: true })).length).toBe(2);
  });

  it('delete：入边级联（删 B，A→B/C→B 均软删）+ nodeId 过滤', async () => {
    const a = await createNode(dbPath, { name: 'A' });
    const b = await createNode(dbPath, { name: 'B' });
    const c = await createNode(dbPath, { name: 'C' });
    const { createRel, listRels } = await import('../src/core/index.js');
    await createRel(dbPath, { type: 'knows', from: a.id, to: b.id });
    await createRel(dbPath, { type: 'knows', from: c.id, to: b.id });
    expect((await listRels(dbPath, { nodeId: b.id })).length).toBe(2); // 两条边均关联 B
    await deleteNode(dbPath, b.id);
    expect((await listRels(dbPath, {})).length).toBe(0);      // B 的入边全部级联软删
    expect((await listRels(dbPath, { includeDeleted: true })).length).toBe(2);
  });

  it('getNode 不存在返回 null；updateNode 不存在抛错', async () => {
    expect(await getNode(dbPath, 'nope')).toBeNull();
    await expect(updateNode(dbPath, 'nope', { name: 'X' })).rejects.toThrow(/不存在/);
  });

  it('deleteNode 不存在（含已软删）抛错', async () => {
    await expect(deleteNode(dbPath, 'nope')).rejects.toThrow(/不存在/);
    const a = await createNode(dbPath, { name: 'A' });
    await deleteNode(dbPath, a.id);
    await expect(deleteNode(dbPath, a.id)).rejects.toThrow(/不存在/); // 二次删除也 404
  });

  it('restore：软删后还原，节点回来（默认列表可见）+ 级联软删的边一并还原', async () => {
    const a = await createNode(dbPath, { name: 'A' });
    const b = await createNode(dbPath, { name: 'B' });
    const c = await createNode(dbPath, { name: 'C' });
    const { createRel, listRels } = await import('../src/core/index.js');
    await createRel(dbPath, { type: 'knows', from: a.id, to: b.id });
    await createRel(dbPath, { type: 'knows', from: c.id, to: b.id });
    await deleteNode(dbPath, b.id); // B 的入边两条级联软删
    expect((await listNodes(dbPath, {})).map((n) => n.name)).toEqual(['A', 'C']);
    const restored = await restoreNode(dbPath, b.id);
    expect(restored.id).toBe(b.id);
    expect(restored.deleted_time).toBeNull();
    expect((await listNodes(dbPath, {})).map((n) => n.name)).toEqual(['A', 'B', 'C']); // 默认列表可见
    expect((await listRels(dbPath, {})).length).toBe(2); // 边一并还原
  });

  it('restore：未删节点 / ghost id 抛不存在', async () => {
    await expect(restoreNode(dbPath, 'nope')).rejects.toThrow(/节点不存在/);
    const a = await createNode(dbPath, { name: 'A' });
    await expect(restoreNode(dbPath, a.id)).rejects.toThrow(/节点不存在/); // 未删不可还原
  });

  it('restore：未删行已有同名 → 已存在，节点保持软删', async () => {
    const a = await createNode(dbPath, { name: 'A' });
    await deleteNode(dbPath, a.id);
    await createNode(dbPath, { name: 'A' }); // 软删后同名重建 A'
    await expect(restoreNode(dbPath, a.id)).rejects.toThrow(/已存在/); // 还原会让重名违反唯一性
    const named = (await listNodes(dbPath, { includeDeleted: true })).filter((n) => n.name === 'A');
    expect(named.filter((n) => n.deleted_time).length).toBe(1); // A 仍软删
  });

  it('restore：节点独立软删的边（先删边再删节点）还原后一并还原', async () => {
    const a = await createNode(dbPath, { name: 'A' });
    const b = await createNode(dbPath, { name: 'B' });
    const { createRel, deleteRel, listRels } = await import('../src/core/index.js');
    const r = await createRel(dbPath, { type: 'knows', from: a.id, to: b.id });
    await deleteRel(dbPath, r.id); // 边先独立软删
    await deleteNode(dbPath, a.id);
    await restoreNode(dbPath, a.id);
    expect((await listRels(dbPath, {})).length).toBe(1); // 级联还原全部软删边
  });

  it('restore：同 id 双软删边（软删后重建又被级联软删）歧义不还原，图不崩', async () => {
    const a = await createNode(dbPath, { name: 'A' });
    const b = await createNode(dbPath, { name: 'B' });
    const { createRel, deleteRel, listRels, getGraph } = await import('../src/core/index.js');
    const r = await createRel(dbPath, { type: 'knows', from: a.id, to: b.id });
    await deleteRel(dbPath, r.id);                                             // 旧边软删
    await createRel(dbPath, { type: 'knows', from: a.id, to: b.id });          // 同 id 重建
    await deleteNode(dbPath, a.id);                                            // 级联软删重建边 → 同 id 两条软删行
    await restoreNode(dbPath, a.id);
    expect((await listRels(dbPath, {})).length).toBe(0);                       // 歧义：一条都不还原
    expect((await listRels(dbPath, { includeDeleted: true })).length).toBe(2); // 删痕保留
    const g = await getGraph(dbPath);                                          // 不抛错（同 id 双未删边会致前端图崩）
    expect(g.edges.length).toBe(0);
  });

  it('restore：对端仍软删的边不还原，待对端还原时带回', async () => {
    const a = await createNode(dbPath, { name: 'A' });
    const b = await createNode(dbPath, { name: 'B' });
    const { createRel, listRels } = await import('../src/core/index.js');
    await createRel(dbPath, { type: 'knows', from: a.id, to: b.id });
    await deleteNode(dbPath, a.id); // 边随 A 级联软删
    await deleteNode(dbPath, b.id);
    await restoreNode(dbPath, a.id);
    expect((await listNodes(dbPath, {})).map((n) => n.name)).toEqual(['A']);
    expect((await listRels(dbPath, {})).length).toBe(0); // 对端 B 仍删：边保持软删
    await restoreNode(dbPath, b.id);
    expect((await listRels(dbPath, {})).length).toBe(1); // B 还原时其级联带回边
  });
});

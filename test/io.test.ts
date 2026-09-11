import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureSchema, createNode, createRel, deleteNode, exportJson, importJson, getGraph,
  listNodes, listRels, relIdOf,
} from '../src/core/index.js';
import type { ExportData } from '../src/core/index.js';

let dbPath: string;
beforeEach(async () => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't.lbug');
  await ensureSchema(dbPath);
});

/** uuid 形态（8-4-4-4-12 小写十六进制） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function seed(): Promise<{ a: string; b: string }> {
  const a = (await createNode(dbPath, { name: 'A', type: '系统', attrs: { x: '1' } })).id;
  const b = (await createNode(dbPath, { name: 'B' })).id;
  await createRel(dbPath, { type: 'knows', from: a, to: b, attrs: { since: '2020' } });
  return { a, b };
}

/** 深比较前排序（导出无显式顺序；同 name/同端点条目以 deleted_time 决胜——软删+重建场景） */
function sorted(d: ExportData): ExportData {
  const byName = (p: { name?: unknown; deleted_time?: unknown }, q: { name?: unknown; deleted_time?: unknown }) =>
    `${p.name}|${p.deleted_time ?? ''}`.localeCompare(`${q.name}|${q.deleted_time ?? ''}`);
  const byEnds = (
    p: { from?: unknown; to?: unknown; type?: unknown; deleted_time?: unknown },
    q: { from?: unknown; to?: unknown; type?: unknown; deleted_time?: unknown },
  ) => `${p.from}|${p.to}|${p.type}|${p.deleted_time ?? ''}`
    .localeCompare(`${q.from}|${q.to}|${q.type}|${q.deleted_time ?? ''}`);
  return { nodes: [...d.nodes].sort(byName), rels: [...d.rels].sort(byEnds) };
}

describe('exportJson（新格式）', () => {
  it('无 id、动态属性平铺、rel from/to 用 name', async () => {
    const { a } = await seed();
    const d = await exportJson(dbPath, {});
    expect(d.nodes).toHaveLength(2);
    const nodeA = d.nodes.find((n) => n.name === 'A')!;
    expect(nodeA.id).toBeUndefined();
    expect(nodeA.type).toBe('系统');
    expect(nodeA.x).toBe('1'); // attrs 平铺
    expect(nodeA.description).toBe('');
    expect(nodeA.is_deprecate).toBe(false);
    expect(typeof nodeA.created_time).toBe('string');
    expect(nodeA.deleted_time).toBeNull();
    expect(d.rels).toHaveLength(1);
    const r = d.rels[0];
    expect(r.id).toBeUndefined();
    expect(r.type).toBe('knows');
    expect(r.from).toBe('A'); // name 而非 id
    expect(r.to).toBe('B');
    expect(r.since).toBe('2020');
  });

  it('默认不含软删；includeDeleted 含', async () => {
    const { a } = await seed();
    const before = (await exportJson(dbPath, {})).nodes.length;
    await deleteNode(dbPath, a);
    expect((await exportJson(dbPath, {})).nodes.length).toBe(before - 1);
    const all = await exportJson(dbPath, { includeDeleted: true });
    expect(all.nodes.length).toBe(before);
    expect(all.nodes.find((n) => n.name === 'A')?.deleted_time).toBeTruthy();
  });
});

describe('importJson', () => {
  it('round-trip：导出→导入新库→再导出，深相等（排序后）', async () => {
    await seed();
    const data = await exportJson(dbPath, { includeDeleted: true });
    const db2 = join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't2.lbug');
    const counts = await importJson(db2, data, { mode: 'merge' });
    expect(counts).toEqual({ nodes: 2, rels: 1 });
    const data2 = await exportJson(db2, { includeDeleted: true });
    expect(sorted(data2)).toEqual(sorted(data));
    // 节点 id 为 uuid；关系 id 仍由端点 id + type 派生（幂等去重语义保留）
    const nodes2 = await listNodes(db2, {});
    const a2 = nodes2.find((n) => n.name === 'A')!;
    const b2 = nodes2.find((n) => n.name === 'B')!;
    expect(a2.id).toMatch(UUID_RE);
    expect((await listRels(db2, {}))[0].id).toBe(relIdOf(a2.id, b2.id, 'knows'));
  });

  it('merge：同数据重复导入幂等', async () => {
    await seed();
    const data = await exportJson(dbPath, { includeDeleted: true });
    await importJson(dbPath, data, { mode: 'merge' });
    const after = await exportJson(dbPath, { includeDeleted: true });
    expect(after.nodes.length).toBe(2);
    expect(after.rels.length).toBe(1);
  });

  it('merge：文件未删条目撞库（节点同名/关系同端点同 type）→ 跳过不写，未提及的节点不动', async () => {
    const { a, b } = await seed();
    await createNode(dbPath, { name: 'C' });
    const bBefore = (await listNodes(dbPath, {})).find((n) => n.id === b)!;
    const data: ExportData = {
      nodes: [{ name: 'A', type: '接口', custom: '9' }],
      rels: [{ type: 'knows', from: 'A', to: 'B', since: '2024' }],
    };
    await importJson(dbPath, data, { mode: 'merge' });
    const nodes = await listNodes(dbPath, {});
    expect(nodes).toHaveLength(3); // A/B/C 全保留
    const aAfter = nodes.find((n) => n.name === 'A')!;
    expect(aAfter.id).toBe(a);
    expect(aAfter.type).toBe('系统');       // 已存在不处理：原数据不被文件覆盖
    expect(aAfter.attrs).toEqual({ x: '1' });
    // B 未在文件中：原样保留（created_time 不变）
    const bAfter = nodes.find((n) => n.id === b)!;
    expect(bAfter.created_time).toBe(bBefore.created_time);
    // 同端点同 type 关系已存在：跳过（attrs 不被文件版本覆盖）
    const rels = await listRels(dbPath, {});
    expect(rels).toHaveLength(1);
    expect(rels[0].attrs).toEqual({ since: '2020' });
  });

  it('merge：rel from/to 可引用库中现存节点 name（按未删行解析 id）', async () => {
    const ext = await createNode(dbPath, { name: 'Ext' });
    const data: ExportData = {
      nodes: [{ name: 'New' }],
      rels: [{ type: 'dep', from: 'New', to: 'Ext' }],
    };
    await importJson(dbPath, data, { mode: 'merge' });
    const rels = await listRels(dbPath, {});
    expect(rels).toHaveLength(1);
    const newId = (await listNodes(dbPath, {})).find((n) => n.name === 'New')!.id;
    expect(rels[0].from).toBe(newId); // 文件内新建节点：内存解析
    expect(rels[0].to).toBe(ext.id);  // 库中现存节点：查库兜底
  });

  it('replace：清空后导入', async () => {
    await seed();
    await createNode(dbPath, { name: 'C', attrs: { k: 'v' } });
    const data: ExportData = {
      nodes: [{ name: 'Only', type: '接口' }],
      rels: [],
    };
    const counts = await importJson(dbPath, data, { mode: 'replace' });
    expect(counts).toEqual({ nodes: 1, rels: 0 });
    const g = await getGraph(dbPath);
    expect(g.nodes.map((n) => n.name)).toEqual(['Only']);
    expect(g.edges.length).toBe(0);
  });

  it('文件内 name 重复报错且零写入', async () => {
    const data: ExportData = {
      nodes: [
        { name: 'A', type: '', description: '' },
        { name: 'A', description: 'dup' },
      ],
      rels: [],
    };
    await expect(importJson(dbPath, data, { mode: 'merge' })).rejects.toThrow(/名称冲突/);
    expect((await listNodes(dbPath, {})).length).toBe(0);
  });

  it('rels 引用缺失 name 报错（含 name 文案）且零写入', async () => {
    const data: ExportData = {
      nodes: [{ name: 'A' }],
      rels: [{ type: 't', from: 'A', to: 'Ghost' }],
    };
    await expect(importJson(dbPath, data, { mode: 'merge' }))
      .rejects.toThrow(/关系引用了不存在的节点: A -> Ghost/);
    expect((await listNodes(dbPath, {})).length).toBe(0); // 校验先于写
  });

  it('replace：坏引用报错且库未清空', async () => {
    await seed();
    const data: ExportData = {
      nodes: [{ name: 'Only' }],
      rels: [{ type: 't', from: 'Only', to: 'Ghost' }],
    };
    await expect(importJson(dbPath, data, { mode: 'replace' })).rejects.toThrow(/不存在/);
    expect((await listNodes(dbPath, {})).length).toBe(2);
    expect((await getGraph(dbPath)).edges.length).toBe(1);
  });

  it('merge：现存库有文件 rel 的端点（现存关系同 id）→ 跳过不重复不替换', async () => {
    await seed(); // A -knows(since=2020)-> B 已存在
    const data: ExportData = {
      nodes: [{ name: 'X' }], // 不含 A/B：端点走现存 name 解析
      rels: [{ type: 'knows', from: 'A', to: 'B' }],
    };
    await importJson(dbPath, data, { mode: 'merge' });
    const rels = await listRels(dbPath, { includeDeleted: true });
    expect(rels).toHaveLength(1); // 已存在：跳过，不叠加不替换
    expect(rels[0].attrs).toEqual({ since: '2020' }); // 原行保留
  });

  it('非法属性名报错且零写入（校验先于 ALTER）', async () => {
    const data: ExportData = { nodes: [{ name: 'A', 'bad-key': 'x' }], rels: [] };
    await expect(importJson(dbPath, data, { mode: 'merge' })).rejects.toThrow(/非法属性名/);
    expect((await listNodes(dbPath, {})).length).toBe(0);
  });

  it('属性名与系统列大小写相撞（NAME 撞 name）报错且零写入', async () => {
    await seed();
    const data: ExportData = { nodes: [{ name: 'A' }, { name: 'Bad', NAME: 'x' }], rels: [] };
    await expect(importJson(dbPath, data, { mode: 'merge' })).rejects.toThrow(/非法属性名: NAME/);
    expect((await listNodes(dbPath, { includeDeleted: true })).length).toBe(2);
    expect((await listRels(dbPath, { includeDeleted: true })).length).toBe(1);
  });

  it('属性名条目内/跨条目大小写重复（Foo 与 FOO）报错且零写入', async () => {
    await seed();
    // 条目内：同一节点两个仅大小写不同的属性名
    const inEntry: ExportData = {
      nodes: [{ name: 'A' }, { name: 'Bad', Foo: '1', FOO: '2' }],
      rels: [],
    };
    await expect(importJson(dbPath, inEntry, { mode: 'merge' }))
      .rejects.toThrow(/属性名大小写重复: Foo 与 FOO/);
    // 跨条目：两个节点各持一种拼写（ALTER 第二列才撞，同样须预校验拦截）
    const crossEntry: ExportData = {
      nodes: [{ name: 'P', Foo: '1' }, { name: 'Q', FOO: '2' }],
      rels: [],
    };
    await expect(importJson(dbPath, crossEntry, { mode: 'merge' }))
      .rejects.toThrow(/属性名大小写重复/);
    expect((await listNodes(dbPath, { includeDeleted: true })).map((n) => n.name).sort()).toEqual(['A', 'B']);
    expect((await listRels(dbPath, { includeDeleted: true })).length).toBe(1);
  });

  it.each([
    ['created_time', 'garbage'],
    ['updated_time', 'garbage'],
    ['deleted_time', 'garbage'],
    ['is_deprecate', 'oops'],
    ['type', 42],
    ['description', 42],
  ])('merge：%s 坏值拒绝且库零改动（值级校验先于任何写操作）', async (field, bad) => {
    await seed(); // A(attrs x=1) -knows(since=2020)-> B
    // 坏值须在任何写操作前抛出
    const data = {
      nodes: [{ name: 'A' }, { name: 'Bad', [field]: bad }],
      rels: [],
    } as unknown as ExportData;
    await expect(importJson(dbPath, data, { mode: 'merge' })).rejects.toThrow(/Bad/);
    // 库零改动：A（含原 attrs）与 knows 边原样，坏节点未入库
    const nodes = await listNodes(dbPath, { includeDeleted: true });
    expect(nodes.map((n) => n.name).sort()).toEqual(['A', 'B']);
    expect(nodes.find((n) => n.name === 'A')?.attrs).toEqual({ x: '1' });
    const rels = await listRels(dbPath, { includeDeleted: true });
    expect(rels).toHaveLength(1);
    expect(rels[0].attrs).toEqual({ since: '2020' });
  });

  it('动态属性导入自动加 STRING 列，值 String() 化', async () => {
    const data: ExportData = {
      nodes: [{ name: 'A', num: 42, flag: true, note: 'ok' }],
      rels: [],
    };
    await importJson(dbPath, data, { mode: 'merge' });
    const n = (await listNodes(dbPath, {}))[0];
    expect(n.attrs).toEqual({ num: '42', flag: 'true', note: 'ok' });
  });

  it('缺时间戳字段时生成当前时间', async () => {
    const data: ExportData = { nodes: [{ name: 'N1' }], rels: [] };
    await importJson(dbPath, data, { mode: 'merge' });
    const n = (await listNodes(dbPath, {}))[0];
    expect(n.created_time).toBeTruthy();
    expect(n.updated_time).toBeTruthy();
  });

  it('软删条目导入空库 no-op（不新建软删行）；未删条目正常导入', async () => {
    const { a } = await seed();
    await deleteNode(dbPath, a); // 级联软删 A 及其边
    const data = await exportJson(dbPath, { includeDeleted: true }); // B 活跃 + A/边软删
    const db2 = join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't3.lbug');
    await importJson(db2, data, { mode: 'merge' });
    expect((await listNodes(db2, {})).map((n) => n.name)).toEqual(['B']);
    const all = await listNodes(db2, { includeDeleted: true });
    expect(all).toHaveLength(1); // 软删 A 不重建（目标不存在：指令 no-op）
    expect(await listRels(db2, { includeDeleted: true })).toEqual([]); // 软删边不重建
  });

  it('软删+重建同名导出→导入：软删条目 no-op，仅活跃条目导入', async () => {
    const a1 = await createNode(dbPath, { name: 'A', type: '系统' });
    const b = (await createNode(dbPath, { name: 'B' })).id;
    await createRel(dbPath, { type: 'knows', from: a1.id, to: b });
    await deleteNode(dbPath, a1.id);                    // 软删 A + 级联软删边
    const a2 = await createNode(dbPath, { name: 'A' }); // 重建：新 uuid
    expect(a2.id).not.toBe(a1.id);
    await createRel(dbPath, { type: 'knows', from: a2.id, to: b });

    const data = await exportJson(dbPath, { includeDeleted: true });
    expect(data.nodes.filter((n) => n.name === 'A').length).toBe(2); // 1 软删 + 1 活跃
    expect(data.nodes.filter((n) => n.deleted_time).length).toBe(1);
    expect(data.rels.length).toBe(2); // 同端点同 type 两条（1 软删 + 1 活跃）

    const db2 = join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't4.lbug');
    await importJson(db2, data, { mode: 'merge' });
    expect((await listNodes(db2, {})).map((n) => n.name)).toEqual(['A', 'B']); // 未删视图正常
    const all = await listNodes(db2, { includeDeleted: true });
    expect(all).toHaveLength(2); // 软删历史不随导入迁移
    expect(all.filter((n) => n.deleted_time).length).toBe(0);
    const rels = await listRels(db2, { includeDeleted: true });
    expect(rels).toHaveLength(1);
    expect(rels[0].deleted_time).toBeNull();
  });

  it('merge：文件未删 name 撞库未删行 → 跳过原样；撞库软删行 → uuid 新建', async () => {
    // 库中软删 A + 未删 A 并存
    const a1 = await createNode(dbPath, { name: 'A', attrs: { v: 'old' } });
    await deleteNode(dbPath, a1.id);
    const a2 = await createNode(dbPath, { name: 'A' });
    await importJson(dbPath, { nodes: [{ name: 'A', type: '接口' }], rels: [] }, { mode: 'merge' });
    const actives = await listNodes(dbPath, {});
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe(a2.id);            // 已存在：跳过，原样保留
    expect(actives[0].type).toBe('');
    expect(actives[0].attrs).toEqual({});
    const all = await listNodes(dbPath, { includeDeleted: true });
    expect(all).toHaveLength(2);                  // 库中软删行不动
    expect(all.filter((n) => n.deleted_time).length).toBe(1);

    // 库中仅有软删同名行（无未删行）→ uuid 新建，软删行保留
    const db2 = join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't5.lbug');
    await ensureSchema(db2);
    const s1 = await createNode(db2, { name: 'A' });
    await deleteNode(db2, s1.id);
    await importJson(db2, { nodes: [{ name: 'A' }], rels: [] }, { mode: 'merge' });
    const actives2 = await listNodes(db2, {});
    expect(actives2).toHaveLength(1);
    expect(actives2[0].id).not.toBe(s1.id);       // 新 uuid，非复活软删行
    expect(actives2[0].id).toMatch(UUID_RE);
    expect((await listNodes(db2, { includeDeleted: true })).length).toBe(2);
  });

  it('时间字段支持 "now" 取导入时刻（含删除指令 deleted_time）', async () => {
    await seed(); // A -knows-> B
    const t0 = Date.now();
    const data: ExportData = {
      nodes: [
        { name: 'N', created_time: 'now', updated_time: 'now' },
        { name: 'A', deleted_time: 'now' }, // 删除指令：deleted_time 取导入时刻
      ],
      rels: [],
    };
    await importJson(dbPath, data, { mode: 'merge' });
    const nodes = await listNodes(dbPath, { includeDeleted: true });
    const n = nodes.find((x) => x.name === 'N')!;
    expect(Math.abs(new Date(n.created_time).getTime() - t0)).toBeLessThan(5000);
    expect(Math.abs(new Date(n.updated_time).getTime() - t0)).toBeLessThan(5000);
    const a = nodes.find((x) => x.name === 'A')!;
    expect(a.deleted_time).toBeTruthy();
    expect(Math.abs(new Date(a.deleted_time!).getTime() - t0)).toBeLessThan(5000);
    // A 软删 → knows 边级联软删（同为导入时刻）
    const rel = (await listRels(dbPath, { includeDeleted: true }))[0];
    expect(rel.deleted_time).toBeTruthy();
    expect(Math.abs(new Date(rel.deleted_time!).getTime() - t0)).toBeLessThan(5000);
  });

  it('节点缺少 name / rel 缺少 type 报错', async () => {
    await expect(importJson(dbPath, { nodes: [{ description: 'x' } as never], rels: [] }, { mode: 'merge' }))
      .rejects.toThrow(/缺少 name/);
    await expect(importJson(dbPath, { nodes: [], rels: [{ from: 'A', to: 'B' } as never] }, { mode: 'merge' }))
      .rejects.toThrow(/缺少 type/);
  });

  it('merge：软删节点命中库未删行 → 软删（deleted_time 用文件值）并级联软删其全部活跃关系；未命中 → no-op', async () => {
    const { a } = await seed(); // A -knows-> B
    const c = (await createNode(dbPath, { name: 'C' })).id;
    await createRel(dbPath, { type: 'loves', from: c, to: a }); // 入边也须级联
    const dt = '2024-05-01T08:09:10Z';
    const data: ExportData = {
      nodes: [{ name: 'A', deleted_time: dt }, { name: 'Ghost', deleted_time: dt }],
      rels: [], // 文件未删任何关系：A 的活跃边仍须随节点级联软删
    };
    await importJson(dbPath, data, { mode: 'merge' });
    expect((await listNodes(dbPath, {})).map((n) => n.name).sort()).toEqual(['B', 'C']);
    const all = await listNodes(dbPath, { includeDeleted: true });
    const softA = all.find((n) => n.name === 'A')!;
    expect(softA.deleted_time).toBe(new Date(dt).toISOString());
    expect(all.find((n) => n.name === 'Ghost')).toBeUndefined(); // 未命中：不新建软删行
    const rels = await listRels(dbPath, { includeDeleted: true });
    expect(rels).toHaveLength(2);
    expect(rels.every((r) => r.deleted_time !== null)).toBe(true); // 出边+入边均级联软删
  });

  it('merge：软删关系命中库未删同 id 行 → 软删；端点缺失 → no-op', async () => {
    await seed(); // A -knows-> B 活跃
    const dt = '2024-05-01T08:09:10Z';
    const data: ExportData = {
      nodes: [],
      rels: [
        { type: 'knows', from: 'A', to: 'B', deleted_time: dt },
        { type: 'uses', from: 'Ghost1', to: 'Ghost2', deleted_time: dt },
      ],
    };
    await importJson(dbPath, data, { mode: 'merge' });
    expect((await listNodes(dbPath, { includeDeleted: true })).length).toBe(2); // A/B 不动
    const rels = await listRels(dbPath, { includeDeleted: true });
    expect(rels).toHaveLength(1);
    expect(rels[0].deleted_time).toBe(new Date(dt).toISOString());
  });

  it('merge：未删关系引用文件中删除的节点 → 报错且零写入', async () => {
    await seed();
    const data: ExportData = {
      nodes: [{ name: 'A', deleted_time: '2024-05-01T00:00:00Z' }, { name: 'B' }],
      rels: [{ type: 'knows', from: 'B', to: 'A' }],
    };
    await expect(importJson(dbPath, data, { mode: 'merge' }))
      .rejects.toThrow(/关系引用了文件中已删除的节点/);
    expect((await listNodes(dbPath, { includeDeleted: true })).length).toBe(2); // 库零改动
    expect((await listRels(dbPath, { includeDeleted: true })).length).toBe(1);
  });

  it('replace：软删条目不保存（清空后无未删同名行，指令 no-op）', async () => {
    await seed();
    const data: ExportData = {
      nodes: [{ name: 'A', deleted_time: '2024-05-01T00:00:00Z' }, { name: 'Only' }],
      rels: [],
    };
    const counts = await importJson(dbPath, data, { mode: 'replace' });
    expect(counts).toEqual({ nodes: 1, rels: 0 }); // counts 只计实际新建
    expect((await listNodes(dbPath, { includeDeleted: true })).map((n) => n.name))
      .toEqual(['Only']); // 无软删行残留
  });
});

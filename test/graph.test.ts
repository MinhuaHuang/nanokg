import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureSchema, createNode, createRel, deleteNode, deleteRel, updateNode, updateRel,
  getGraph, getGraphAround,
} from '../src/core/index.js';

let dbPath: string;
let ids: string[] = [];
beforeEach(async () => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't.lbug');
  await ensureSchema(dbPath);
  // 链: n0 -> n1 -> n2 -> n3 -> n4 -> n5 -> n6（7 节点 6 边）
  ids = [];
  for (let i = 0; i < 7; i++) ids.push((await createNode(dbPath, { name: `n${i}` })).id);
  for (let i = 0; i < 6; i++) await createRel(dbPath, { type: 'next', from: ids[i], to: ids[i + 1] });
});

describe('getGraph', () => {
  it('全量节点 + 边（未删）', async () => {
    const g = await getGraph(dbPath);
    expect(g.nodes.length).toBe(7);
    expect(g.edges.length).toBe(6);
    expect(g.edges[0].from).toBeTruthy();
  });

  it('软删节点与边排除；已删边使对端仍显示但边不见', async () => {
    // 无序返回下 edges[0] 不稳定，按端点确定性选边（n0->n1）
    const g0 = await getGraph(dbPath);
    const e = g0.edges.find((x) => x.from === ids[0] && x.to === ids[1])!;
    await deleteRel(dbPath, e.id);
    const g = await getGraph(dbPath);
    expect(g.edges.length).toBe(5);
    expect(g.nodes.length).toBe(7); // 节点没删
    await deleteNode(dbPath, ids[6]);
    const g2 = await getGraph(dbPath);
    expect(g2.nodes.length).toBe(6);
    expect(g2.edges.length).toBe(4); // n5->n6 边随 n6 级联软删 + 手删那条
  });
});

describe('getGraph 查询条件（includeDeprecate/includeDeleted）', () => {
  it('默认含弃用（现状不变）', async () => {
    await updateNode(dbPath, ids[3], { is_deprecate: true });
    const g = await getGraph(dbPath);
    expect(g.nodes.length).toBe(7);
    expect(g.edges.length).toBe(6);
  });

  it('includeDeleted=true：软删节点与级联软删边出现', async () => {
    await deleteNode(dbPath, ids[6]);
    const g = await getGraph(dbPath, { includeDeleted: true });
    expect(g.nodes.length).toBe(7);
    expect(g.edges.length).toBe(6); // n5->n6 级联软删边一并回来
  });

  it('includeDeprecate=false：弃用节点与其关联边消失', async () => {
    await updateNode(dbPath, ids[3], { is_deprecate: true });
    const g = await getGraph(dbPath, { includeDeprecate: false });
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['n0', 'n1', 'n2', 'n4', 'n5', 'n6']);
    expect(g.edges.length).toBe(4); // n2->n3、n3->n4 端点弃用被排除
  });

  it('includeDeprecate=false：弃用边自身（端点未弃用）也被排除', async () => {
    // 弃用关系 n0->n1：两端点未弃用，仅边弃用
    const before = await getGraph(dbPath);
    await updateRel(dbPath, before.edges.find((e) => e.from === ids[0] && e.to === ids[1])!.id, { is_deprecate: true });
    expect((await getGraph(dbPath)).edges.length).toBe(6); // 默认含弃用边
    const g = await getGraph(dbPath, { includeDeprecate: false });
    expect(g.edges.length).toBe(5); // 弃用边被排除
    expect(g.nodes.length).toBe(7); // 节点不受影响
  });

  it('组合：includeDeleted=true + includeDeprecate=false（软删不过滤、弃用仍过滤）', async () => {
    await updateNode(dbPath, ids[3], { is_deprecate: true });
    await deleteNode(dbPath, ids[6]);
    const g = await getGraph(dbPath, { includeDeleted: true, includeDeprecate: false });
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['n0', 'n1', 'n2', 'n4', 'n5', 'n6']);
    expect(g.edges.length).toBe(4);
  });

  it('getGraphAround 透传 opts（depth=1 + includeDeprecate=false）', async () => {
    await updateNode(dbPath, ids[4], { is_deprecate: true });
    const g = await getGraphAround(dbPath, ids[3], 1, { includeDeprecate: false });
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['n2', 'n3']); // 邻居 n4 弃用被排除
    expect(g.edges.length).toBe(1);
  });
});

describe('getGraphAround', () => {
  it('默认 5 跳：中心 n0 取到 n5，不含 n6', async () => {
    const g = await getGraphAround(dbPath, ids[0]);
    expect(g.centerId).toBe(ids[0]);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
    expect(g.edges.length).toBe(5);
  });

  it('depth=2', async () => {
    const g = await getGraphAround(dbPath, ids[0], 2);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['n0', 'n1', 'n2']);
    expect(g.edges.length).toBe(2);
  });

  it("depth='all' 不限跳数", async () => {
    const g = await getGraphAround(dbPath, ids[0], 'all');
    expect(g.nodes.length).toBe(7);
    expect(g.edges.length).toBe(6);
  });

  it('depth=1 反向可达：中心 n3 深度 1 取 n2 与 n4', async () => {
    const g = await getGraphAround(dbPath, ids[3], 1);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['n2', 'n3', 'n4']);
  });

  it('中心不存在抛错', async () => {
    await expect(getGraphAround(dbPath, 'ghost')).rejects.toThrow(/不存在/);
  });

  it('孤节点：只返回自己', async () => {
    const solo = (await createNode(dbPath, { name: 'solo' })).id;
    const g = await getGraphAround(dbPath, solo);
    expect(g.nodes.length).toBe(1);
    expect(g.edges.length).toBe(0);
  });

  it('方向一致：中心 -> A <- B 的 B 不收录（方向翻转只在中心）', async () => {
    const a = (await createNode(dbPath, { name: 'a' })).id;
    const b = (await createNode(dbPath, { name: 'b' })).id;
    await createRel(dbPath, { type: 'next', from: ids[0], to: a });
    await createRel(dbPath, { type: 'next', from: b, to: a });
    const g = await getGraphAround(dbPath, ids[0], 'all');
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['a', 'n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    expect(g.edges.every((e) => e.from !== b && e.to !== b)).toBe(true);
  });

  it('双向链路：B <- A <- 中心 -> E -> F 都收录', async () => {
    const mk = async (name: string) => (await createNode(dbPath, { name })).id;
    const [w, a, c, e, f] = await Promise.all([mk('w'), mk('a'), mk('c'), mk('e'), mk('f')]);
    await createRel(dbPath, { type: 'next', from: w, to: a });
    await createRel(dbPath, { type: 'next', from: a, to: c });
    await createRel(dbPath, { type: 'next', from: c, to: e });
    await createRel(dbPath, { type: 'next', from: e, to: f });
    const g = await getGraphAround(dbPath, c, 2);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['a', 'c', 'e', 'f', 'w']);
    expect(g.edges.length).toBe(4);
  });

  it('同一节点双向可达不截断反向链：环 c->a、a->c 时 w->a 的 w 仍收录', async () => {
    const mk = async (name: string) => (await createNode(dbPath, { name })).id;
    const [c, a, w] = await Promise.all([mk('c'), mk('a'), mk('w')]);
    await createRel(dbPath, { type: 'next', from: c, to: a });
    await createRel(dbPath, { type: 'next', from: a, to: c });
    await createRel(dbPath, { type: 'next', from: w, to: a });
    const g = await getGraphAround(dbPath, c, 'all');
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['a', 'c', 'w']);
  });
});

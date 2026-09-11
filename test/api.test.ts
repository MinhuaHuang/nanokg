import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/server/index.js';

let app: ReturnType<typeof createApp>;
let dbPath: string;
beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't.lbug');
  app = createApp({ dbPath });
});

describe('POST /api/nodes', () => {
  it('创建返回 201 + 记录（type/attrs/审计字段）', async () => {
    const res = await request(app).post('/api/nodes')
      .send({ name: 'Alice', type: '系统', attrs: { owner: 'bob' } });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Alice');
    expect(res.body.type).toBe('系统');
    expect(res.body.attrs).toEqual({ owner: 'bob' });
    expect(res.body.created_time).toBeTruthy();
    expect(res.body.deleted_time).toBeNull();
  });
  it('缺省 type 为空串、attrs 为空对象', async () => {
    const res = await request(app).post('/api/nodes').send({ name: 'A' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('');
    expect(res.body.attrs).toEqual({});
  });
  it('name 重复 400（确定性 id：同名即同节点）', async () => {
    await request(app).post('/api/nodes').send({ name: 'A' });
    const res = await request(app).post('/api/nodes').send({ name: 'A' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/已存在/);
  });
  it('缺 name 400', async () => {
    const res = await request(app).post('/api/nodes').send({});
    expect(res.status).toBe(400);
  });
  it('非字符串 name（数字）强转后 201（原为 500）', async () => {
    const res = await request(app).post('/api/nodes').send({ name: 123 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('123');
  });
  it('attrs 非对象 / 含非字符串值 400', async () => {
    for (const attrs of ['x', ['x'], { owner: 1 }, { owner: null }]) {
      const res = await request(app).post('/api/nodes').send({ name: 'A', attrs });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('attrs 须为字符串键值对象');
    }
  });
  it('malformed JSON 400', async () => {
    const res = await request(app).post('/api/nodes')
      .set('Content-Type', 'application/json').send('{"broken');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

describe('GET /api/nodes', () => {
  it('name 过滤 + includeDeleted + 字段形态', async () => {
    const a = (await request(app).post('/api/nodes')
      .send({ name: 'Alice', type: '系统', attrs: { owner: 'me' } })).body;
    await request(app).post('/api/nodes').send({ name: 'Bob' });
    const list = (await request(app).get('/api/nodes')).body;
    expect(list.length).toBe(2);
    expect(list[0].name).toBe('Alice'); // ORDER BY name
    expect(list[0].type).toBe('系统');
    expect(list[0].attrs).toEqual({ owner: 'me' });
    await request(app).delete(`/api/nodes/${a.id}`);
    expect((await request(app).get('/api/nodes')).body.length).toBe(1);
    expect((await request(app).get('/api/nodes?includeDeleted=true')).body.length).toBe(2);
    expect((await request(app).get('/api/nodes?name=Bob')).body.length).toBe(1);
    expect((await request(app).get('/api/nodes?name=Ali')).body.length).toBe(0); // 已软删：name 过滤同样默认排除
  });
});

describe('GET /api/nodes 查询条件 + GET /api/types', () => {
  it('type 精确过滤 / includeDeprecate=false / 组合 / 类型清单', async () => {
    await request(app).post('/api/nodes').send({ name: 'Alice', type: '系统' });
    await request(app).post('/api/nodes').send({ name: 'Bob', type: '接口' });
    await request(app).post('/api/nodes').send({ name: 'Carol', type: '系统', is_deprecate: true });
    await request(app).post('/api/nodes').send({ name: 'Dave' }); // 空 type
    const gone = (await request(app).post('/api/nodes').send({ name: 'Eve', type: '服务' })).body;
    await request(app).delete(`/api/nodes/${gone.id}`); // 软删「服务」

    // type 精确过滤（默认含弃用）
    expect((await request(app).get('/api/nodes?type=系统')).body.map((n: { name: string }) => n.name))
      .toEqual(['Alice', 'Carol']);
    // includeDeprecate=false 排除弃用（其余值/缺省默认含）
    expect((await request(app).get('/api/nodes?type=系统&includeDeprecate=false')).body
      .map((n: { name: string }) => n.name)).toEqual(['Alice']);
    // type + name 组合
    expect((await request(app).get('/api/nodes?type=系统&name=Car')).body
      .map((n: { name: string }) => n.name)).toEqual(['Carol']);
    // /api/types：未删节点 DISTINCT、排除空串、字典序；弃用节点的 type 算「库中存在」，软删节点不算
    expect((await request(app).get('/api/types')).body).toEqual(['接口', '系统']);
  });
});

describe('PUT/DELETE/GET /api/nodes/:id', () => {
  it('更新（type/attrs）/软删/404', async () => {
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    const u = await request(app).put(`/api/nodes/${a.id}`)
      .send({ type: '系统', description: 'd', attrs: { owner: 'x' }, is_deprecate: true });
    expect(u.body.type).toBe('系统');
    expect(u.body.attrs).toEqual({ owner: 'x' });
    expect(u.body.is_deprecate).toBe(true);
    expect((await request(app).delete(`/api/nodes/${a.id}`)).status).toBe(204);
    expect((await request(app).get(`/api/nodes/${a.id}`)).status).toBe(404);
    expect((await request(app).delete(`/api/nodes/${a.id}`)).status).toBe(404); // 二次删
    expect((await request(app).put(`/api/nodes/${a.id}`).send({ name: 'X' })).status).toBe(404); // 软删后更新
    expect((await request(app).put(`/api/nodes/nope`).send({ name: 'X' })).status).toBe(404);
  });
});

describe('POST /api/nodes/:id/restore', () => {
  it('软删 → restore 200（deleted_time null，级联边一并还原）→ 默认列表可见', async () => {
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    const b = (await request(app).post('/api/nodes').send({ name: 'B' })).body;
    await request(app).post('/api/rels').send({ type: 't', from: a.id, to: b.id });
    await request(app).delete(`/api/nodes/${a.id}`);
    const res = await request(app).post(`/api/nodes/${a.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.deleted_time).toBeNull();
    expect((await request(app).get('/api/nodes')).body.length).toBe(2);
    expect((await request(app).get('/api/rels')).body.length).toBe(1); // 边一并还原
  });
  it('未删 / ghost restore 404', async () => {
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    expect((await request(app).post(`/api/nodes/${a.id}/restore`)).status).toBe(404);
    expect((await request(app).post('/api/nodes/ghost/restore')).status).toBe(404);
  });
  it('未删行已有同名 → 400 已存在', async () => {
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    await request(app).delete(`/api/nodes/${a.id}`);
    await request(app).post('/api/nodes').send({ name: 'A' }); // 同名重建
    const res = await request(app).post(`/api/nodes/${a.id}/restore`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/已存在/);
  });
});

describe('/api/rels', () => {
  it('CRUD 全流程 + 端点校验', async () => {
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    const b = (await request(app).post('/api/nodes').send({ name: 'B' })).body;
    const r = (await request(app).post('/api/rels')
      .send({ type: 'knows', from: a.id, to: b.id, attrs: { since: '2020' } })).body;
    expect(r.type).toBe('knows');
    expect(r.from).toBe(a.id);
    expect(r.to).toBe(b.id);
    expect(r.attrs).toEqual({ since: '2020' });
    expect((await request(app).get(`/api/rels?nodeId=${a.id}`)).body.length).toBe(1);
    const u = await request(app).put(`/api/rels/${r.id}`).send({ type: 'likes', attrs: { since: '2021' } });
    expect(u.body.type).toBe('likes');
    expect(u.body.attrs).toEqual({ since: '2021' });
    expect((await request(app).delete(`/api/rels/${r.id}`)).status).toBe(204);
    expect((await request(app).put(`/api/rels/${r.id}`).send({ type: 'x' })).status).toBe(404); // 软删后更新
    expect((await request(app).get('/api/rels')).body.length).toBe(0);
    const bad = await request(app).post('/api/rels').send({ type: 'x', from: 'a', to: 'b' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/不存在/);
  });
  it('同 from/to/type 重复创建 400 已存在', async () => {
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    const b = (await request(app).post('/api/nodes').send({ name: 'B' })).body;
    const first = await request(app).post('/api/rels').send({ type: 'knows', from: a.id, to: b.id });
    expect(first.status).toBe(201);
    const dup = await request(app).post('/api/rels').send({ type: 'knows', from: a.id, to: b.id });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toMatch(/已存在/);
  });
  it('自环 400', async () => {
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    const res = await request(app).post('/api/rels').send({ type: 'x', from: a.id, to: a.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/自环/);
  });
  it('attrs 非法 400', async () => {
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    const b = (await request(app).post('/api/nodes').send({ name: 'B' })).body;
    const res = await request(app).post('/api/rels').send({ type: 't', from: a.id, to: b.id, attrs: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('attrs 须为字符串键值对象');
  });
});

describe('POST /api/rels/:id/restore', () => {
  it('软删 → restore 200（级联软删端点一并恢复，默认可见）', async () => {
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    const b = (await request(app).post('/api/nodes').send({ name: 'B' })).body;
    const r = (await request(app).post('/api/rels').send({ type: 'knows', from: a.id, to: b.id })).body;
    await request(app).delete(`/api/nodes/${a.id}`); // 边随 A 级联软删
    const res = await request(app).post(`/api/rels/${r.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.deleted_time).toBeNull();
    expect((await request(app).get('/api/nodes')).body.length).toBe(2); // 软删端点 A 一并恢复
    expect((await request(app).get('/api/rels')).body.length).toBe(1);  // 默认可见
  });
  it('未删幂等 200 / ghost 404', async () => {
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    const b = (await request(app).post('/api/nodes').send({ name: 'B' })).body;
    const r = (await request(app).post('/api/rels').send({ type: 't', from: a.id, to: b.id })).body;
    const again = await request(app).post(`/api/rels/${r.id}/restore`);
    expect(again.status).toBe(200);
    expect(again.body.deleted_time).toBeNull();
    expect((await request(app).get('/api/rels')).body.length).toBe(1);
    expect((await request(app).post('/api/rels/ghost/restore')).status).toBe(404);
  });
});

describe('API 兜底', () => {
  it('未知 /api 端点 404 JSON', async () => {
    const res = await request(app).get('/api/unknown');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('端点不存在');
  });
});

describe('GET /api/graph', () => {
  it('全量图', async () => {
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    const b = (await request(app).post('/api/nodes').send({ name: 'B' })).body;
    await request(app).post('/api/rels').send({ type: 't', from: a.id, to: b.id });
    const g = (await request(app).get('/api/graph')).body;
    expect(g.nodes.length).toBe(2);
    expect(g.edges.length).toBe(1);
  });

  it('查询条件透传：includeDeleted=true / includeDeprecate=false / 组合', async () => {
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    const b = (await request(app).post('/api/nodes').send({ name: 'B' })).body;
    const c = (await request(app).post('/api/nodes').send({ name: 'C' })).body;
    const d = (await request(app).post('/api/nodes').send({ name: 'D' })).body;
    await request(app).post('/api/rels').send({ type: 't', from: a.id, to: b.id });
    await request(app).post('/api/rels').send({ type: 't', from: c.id, to: d.id });
    await request(app).put(`/api/nodes/${a.id}`).send({ is_deprecate: true }); // A 弃用
    await request(app).delete(`/api/nodes/${c.id}`); // C 软删（级联 C->D 边）

    // 默认：含弃用、不含软删（现状）
    const g0 = (await request(app).get('/api/graph')).body;
    expect(g0.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['A', 'B', 'D']);
    expect(g0.edges.length).toBe(1); // A->B（弃用端点默认保留）
    // includeDeleted=true：C 与级联软删边 C->D 回来
    const g1 = (await request(app).get('/api/graph?includeDeleted=true')).body;
    expect(g1.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(g1.edges.length).toBe(2);
    // includeDeprecate=false：弃用 A 与其关联边消失
    const g2 = (await request(app).get('/api/graph?includeDeprecate=false')).body;
    expect(g2.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['B', 'D']);
    expect(g2.edges.length).toBe(0);
    // 组合：软删不过滤、弃用仍过滤
    const g3 = (await request(app).get('/api/graph?includeDeleted=true&includeDeprecate=false')).body;
    expect(g3.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['B', 'C', 'D']);
    expect(g3.edges.length).toBe(1); // C->D（软删边含），A->B 端点弃用排除
  });
});

describe('GET /api/graph/:nodeId', () => {
  it('默认 5 跳 / depth=2 / depth=all / depth 非法 400', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await request(app).post('/api/nodes').send({ name: `n${i}` })).body.id);
    for (let i = 0; i < 6; i++) await request(app).post('/api/rels').send({ type: 'next', from: ids[i], to: ids[i + 1] });
    const g5 = (await request(app).get(`/api/graph/${ids[0]}`)).body;
    expect(g5.nodes.length).toBe(6);
    expect(g5.centerId).toBe(ids[0]);
    expect((await request(app).get(`/api/graph/${ids[0]}?depth=2`)).body.nodes.length).toBe(3);
    expect((await request(app).get(`/api/graph/${ids[0]}?depth=all`)).body.nodes.length).toBe(7);
    const bad = await request(app).get(`/api/graph/${ids[0]}?depth=0`);
    expect(bad.status).toBe(400);
    expect((await request(app).get('/api/graph/ghost')).status).toBe(404);
  });

  it('查询条件透传：includeDeprecate=false / includeDeleted=true', async () => {
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    const b = (await request(app).post('/api/nodes').send({ name: 'B' })).body;
    const c = (await request(app).post('/api/nodes').send({ name: 'C' })).body;
    await request(app).post('/api/rels').send({ type: 't', from: a.id, to: b.id });
    await request(app).put(`/api/nodes/${b.id}`).send({ is_deprecate: true }); // 邻居 B 弃用
    // 默认（含弃用）：中心 A 一跳含 B
    const g0 = (await request(app).get(`/api/graph/${a.id}`)).body;
    expect(g0.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['A', 'B']);
    expect(g0.edges.length).toBe(1);
    // includeDeprecate=false：B 被排除，只剩中心
    const g1 = (await request(app).get(`/api/graph/${a.id}?includeDeprecate=false`)).body;
    expect(g1.nodes.map((n: { name: string }) => n.name)).toEqual(['A']);
    expect(g1.edges.length).toBe(0);
    // includeDeleted=true：软删邻居与级联边回来
    await request(app).post('/api/rels').send({ type: 't', from: a.id, to: c.id });
    await request(app).delete(`/api/nodes/${c.id}`);
    const g2 = (await request(app).get(`/api/graph/${a.id}`)).body;
    expect(g2.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['A', 'B']);
    const g3 = (await request(app).get(`/api/graph/${a.id}?includeDeleted=true`)).body;
    expect(g3.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['A', 'B', 'C']);
    expect(g3.edges.length).toBe(2);
  });
});

describe('GET /api/schema', () => {
  it('空库 dynamic 空；写入动态属性后出现对应列', async () => {
    const s0 = (await request(app).get('/api/schema')).body;
    expect(s0.node.system).toEqual(expect.arrayContaining(['id', 'name', 'type', 'is_deprecate']));
    expect(s0.rel.system).toEqual(expect.arrayContaining(['id', 'type', 'is_deprecate']));
    expect(s0.node.dynamic).toEqual([]);
    expect(s0.rel.dynamic).toEqual([]);
    const b = (await request(app).post('/api/nodes').send({ name: 'B', attrs: { owner: 'x' } })).body;
    const a = (await request(app).post('/api/nodes').send({ name: 'A' })).body;
    await request(app).post('/api/rels').send({ type: 't', from: a.id, to: b.id, attrs: { since: '2020' } });
    const s1 = (await request(app).get('/api/schema')).body;
    expect(s1.node.dynamic).toEqual(['owner']);
    expect(s1.rel.dynamic).toEqual(['since']);
  });
});

describe('POST /api/query', () => {
  it('Cypher 透传（读 + 写）', async () => {
    await request(app).post('/api/nodes').send({ name: 'A' });
    const res = await request(app).post('/api/query').send({ cypher: 'MATCH (n:Node) RETURN n.name AS name' });
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual(['name']);
    expect(res.body.rows[0][0]).toBe('A');
    const w = await request(app).post('/api/query').send({ cypher: "MATCH (n:Node {name: 'A'}) SET n.description = 'x' RETURN n.description AS d" });
    expect(w.body.rows[0][0]).toBe('x');
  });
  it('空 cypher 400 / 语法错误 400', async () => {
    expect((await request(app).post('/api/query').send({})).status).toBe(400);
    const bad = await request(app).post('/api/query').send({ cypher: 'MATCHH' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBeTruthy();
  });
});

describe('GET /api/export 与 POST /api/import', () => {
  it('round-trip via HTTP（新格式：无 id、attrs 平铺、rel from/to 用 name）', async () => {
    const a = (await request(app).post('/api/nodes')
      .send({ name: 'A', type: '系统', attrs: { owner: 'me' } })).body;
    const b = (await request(app).post('/api/nodes').send({ name: 'B' })).body;
    await request(app).post('/api/rels').send({ type: 't', from: a.id, to: b.id, attrs: { since: '2020' } });
    const exported = (await request(app).get('/api/export')).body;
    expect(exported.nodes.length).toBe(2);
    expect(exported.rels.length).toBe(1);
    expect(exported.nodes[0].id).toBeUndefined(); // 新格式无 id
    expect(exported.nodes[0]).toMatchObject({ name: 'A', type: '系统', owner: 'me' }); // attrs 平铺
    expect(exported.rels[0]).toMatchObject({ type: 't', from: 'A', to: 'B', since: '2020' });
    const dbPath2 = join(mkdtempSync(join(tmpdir(), 'nanokg-')), 't2.lbug');
    const app2 = createApp({ dbPath: dbPath2 });
    const imp = await request(app2).post('/api/import').send({ data: exported, mode: 'merge' });
    expect(imp.status).toBe(200);
    expect(imp.body).toEqual({ nodes: 2, rels: 1 });
    const g2 = (await request(app2).get('/api/graph')).body;
    expect(g2.nodes.length).toBe(2);
    expect(g2.edges.length).toBe(1);
    expect(g2.nodes.find((n: { name: string }) => n.name === 'A'))
      .toMatchObject({ type: '系统', attrs: { owner: 'me' } });
    expect(g2.edges[0].attrs).toEqual({ since: '2020' });
  });

  it('裸新格式导入（rel from/to 用 name 形态）', async () => {
    const data = {
      nodes: [
        { name: 'X', type: '系统', description: 'dx', is_deprecate: false },
        { name: 'Y', type: '', description: '', is_deprecate: false },
      ],
      rels: [{ type: 'knows', from: 'X', to: 'Y', since: '2020' }],
    };
    const imp = await request(app).post('/api/import').send({ data, mode: 'merge' });
    expect(imp.status).toBe(200);
    expect(imp.body).toEqual({ nodes: 2, rels: 1 });
    const nodes = (await request(app).get('/api/nodes')).body;
    expect(nodes.find((n: { name: string }) => n.name === 'X'))
      .toMatchObject({ type: '系统', description: 'dx', attrs: {} });
    const rels = (await request(app).get('/api/rels')).body;
    expect(rels[0]).toMatchObject({ type: 'knows', attrs: { since: '2020' } });
  });

  it('非法 data 400 / replace 模式', async () => {
    expect((await request(app).post('/api/import').send({ data: {} })).status).toBe(400);
    expect((await request(app).post('/api/import').send({})).status).toBe(400);
    await request(app).post('/api/nodes').send({ name: 'Old' });
    const data = { nodes: [{ name: 'Only', type: '', description: '', is_deprecate: false }], rels: [] };
    const imp = await request(app).post('/api/import').send({ data, mode: 'replace' });
    expect(imp.body).toEqual({ nodes: 1, rels: 0 });
    expect((await request(app).get('/api/nodes')).body.map((n: { name: string }) => n.name)).toEqual(['Only']);
  });

  it('mode 非法值 400（不静默降级 merge）', async () => {
    const data = { nodes: [], rels: [] };
    const res = await request(app).post('/api/import').send({ data, mode: 'typo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('mode 须为 merge 或 replace');
    // 缺省 mode 仍默认 merge
    expect((await request(app).post('/api/import').send({ data })).status).toBe(200);
  });
});

describe('静态托管（webDist）', () => {
  it('GET / 与 SPA fallback 返回 index.html；/api 未知仍 JSON 404', async () => {
    const webDist = mkdtempSync(join(tmpdir(), 'nanokg-web-'));
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>nanokg</title>');
    const webApp = createApp({ dbPath, webDist });
    const home = await request(webApp).get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('<title>nanokg</title>');
    const spa = await request(webApp).get('/graph/xyz');
    expect(spa.status).toBe(200);
    expect(spa.text).toContain('<title>nanokg</title>');
    const api = await request(webApp).get('/api/unknown');
    expect(api.status).toBe(404);
    expect(api.body.error).toBe('端点不存在');
  });
});

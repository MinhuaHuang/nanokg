import { Router, type Request, type Response, type NextFunction } from 'express';
import * as core from '../core/index.js';

export function apiRouter(dbPathOf: () => string): Router {
  const r = Router();
  const h = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
  const notFound = (res: Response, what: string) => res.status(404).json({ error: `${what}不存在` });

  // attrs 透传读取：未提交 → undefined；其余须为纯字符串键值对象，否则 400
  // （简单 typeof 校验；列名合法性由 core assertAttrNames 兜底）
  const attrsOf = (v: unknown): Record<string, string> | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'object' || v === null || Array.isArray(v)
      || !Object.values(v).every((x) => typeof x === 'string')) {
      const err = new Error('attrs 须为字符串键值对象') as Error & { status: number };
      err.status = 400; // index.ts 错误中间件优先采用 err.status
      throw err;
    }
    return v as Record<string, string>;
  };

  // nodes
  r.get('/nodes', h(async (req, res) => {
    res.json(await core.listNodes(dbPathOf(), {
      nameLike: req.query.name ? String(req.query.name) : undefined,
      type: req.query.type ? String(req.query.type) : undefined,
      includeDeleted: req.query.includeDeleted === 'true',
      // 'false' 才排除，其余值/缺省默认含弃用
      includeDeprecate: req.query.includeDeprecate !== 'false',
    }));
  }));
  // 类型清单：前端 TypePicker 数据源（未删节点 DISTINCT type，弃用算「库中存在」）
  r.get('/types', h(async (_req, res) => {
    res.json(await core.listNodeTypes(dbPathOf()));
  }));
  r.post('/nodes', h(async (req, res) => {
    // String 强转：非字符串 name（数字/对象等）不能调 .trim()，否则 500
    const name = String(req.body?.name ?? '').trim();
    if (!name) { res.status(400).json({ error: 'name 必填' }); return; }
    res.status(201).json(await core.createNode(dbPathOf(), {
      name,
      type: req.body?.type,
      description: req.body?.description,
      attrs: attrsOf(req.body?.attrs),
      is_deprecate: req.body?.is_deprecate,
    }));
  }));
  r.get('/nodes/:id', h(async (req, res) => {
    const n = await core.getNode(dbPathOf(), req.params.id);
    // core getNode 按 id 精确匹配，不过滤软删；REST 语义下已删资源默认不可见 → 404
    if (!n || n.deleted_time) { notFound(res, '节点'); return; }
    res.json(n);
  }));
  r.put('/nodes/:id', h(async (req, res) => {
    res.json(await core.updateNode(dbPathOf(), req.params.id, {
      name: req.body?.name, type: req.body?.type, description: req.body?.description,
      attrs: attrsOf(req.body?.attrs), is_deprecate: req.body?.is_deprecate,
    }));
  }));
  r.delete('/nodes/:id', h(async (req, res) => {
    await core.deleteNode(dbPathOf(), req.params.id);
    res.status(204).end();
  }));
  // 还原软删节点（级联还原其软删关联边）；未删/不存在 404、同名冲突 400 由 core 文案映射
  r.post('/nodes/:id/restore', h(async (req, res) => {
    res.json(await core.restoreNode(dbPathOf(), req.params.id));
  }));

  // rels
  r.get('/rels', h(async (req, res) => {
    res.json(await core.listRels(dbPathOf(), {
      nodeId: req.query.nodeId ? String(req.query.nodeId) : undefined,
      includeDeleted: req.query.includeDeleted === 'true',
    }));
  }));
  r.post('/rels', h(async (req, res) => {
    // String 强转后校验：非字符串值（数字/对象等）不再依赖隐式真值判断
    const type = String(req.body?.type ?? '').trim();
    const from = String(req.body?.from ?? '').trim();
    const to = String(req.body?.to ?? '').trim();
    if (!type || !from || !to) {
      res.status(400).json({ error: 'type/from/to 必填' }); return;
    }
    res.status(201).json(await core.createRel(dbPathOf(), {
      type, from, to,
      description: req.body?.description, attrs: attrsOf(req.body?.attrs),
      is_deprecate: req.body?.is_deprecate,
    }));
  }));
  r.put('/rels/:id', h(async (req, res) => {
    res.json(await core.updateRel(dbPathOf(), req.params.id, {
      type: req.body?.type, description: req.body?.description,
      attrs: attrsOf(req.body?.attrs), is_deprecate: req.body?.is_deprecate,
    }));
  }));
  r.delete('/rels/:id', h(async (req, res) => {
    await core.deleteRel(dbPathOf(), req.params.id);
    res.status(204).end();
  }));
  // 还原软删关系（级联还原软删端点节点，先节点后关系）；未删幂等 200、不存在 404 由 core 文案映射
  r.post('/rels/:id/restore', h(async (req, res) => {
    res.json(await core.restoreRel(dbPathOf(), req.params.id));
  }));

  // schema：两表列反射（供 UI 表单动态渲染动态属性字段）
  r.get('/schema', h(async (_req, res) => {
    const dbPath = dbPathOf();
    await core.ensureSchema(dbPath);
    // 反射查询走 per-dbPath 队列：与 ALTER 写并发时避免文件锁冲突
    //（ensureSchema 本身不进队列 — 写函数在队列内调用它，进队列会自死锁）
    const { nodes, rels } = await core.enqueueDbOp(dbPath, () =>
      core.withDb(dbPath, async (conn) => ({
        nodes: await core.tableColumns(conn, 'Node'),
        rels: await core.tableColumns(conn, 'Rel'),
      })));
    res.json({
      node: { system: [...core.NODE_SYSTEM_COLS], dynamic: [...nodes].filter((c) => !core.NODE_SYSTEM_COLS.has(c)) },
      rel: { system: [...core.REL_SYSTEM_COLS], dynamic: [...rels].filter((c) => !core.REL_SYSTEM_COLS.has(c)) },
    });
  }));

  // graph
  // 与 /api/nodes 同款语义：'false' 才排除弃用、'true' 才含软删，其余值/缺省走默认
  const graphOptsOf = (req: Request) => ({
    includeDeprecate: req.query.includeDeprecate !== 'false',
    includeDeleted: req.query.includeDeleted === 'true',
  });
  r.get('/graph', h(async (req, res) => {
    res.json(await core.getGraph(dbPathOf(), graphOptsOf(req)));
  }));
  r.get('/graph/:nodeId', h(async (req, res) => {
    const depthRaw = req.query.depth === undefined ? '5' : String(req.query.depth);
    const depth: number | 'all' = depthRaw === 'all' ? 'all' : Number(depthRaw);
    if (depth !== 'all' && (!Number.isInteger(depth) || depth < 1)) {
      res.status(400).json({ error: 'depth 须为正整数或 all' });
      return;
    }
    res.json(await core.getGraphAround(dbPathOf(), req.params.nodeId, depth, graphOptsOf(req)));
  }));

  // cypher
  r.post('/query', h(async (req, res) => {
    const cypher = String(req.body?.cypher ?? '');
    if (!cypher.trim()) { res.status(400).json({ error: 'cypher 必填' }); return; }
    res.json(await core.queryCypher(dbPathOf(), cypher));
  }));

  // import/export
  r.get('/export', h(async (req, res) => {
    res.json(await core.exportJson(dbPathOf(), { includeDeleted: req.query.includeDeleted === 'true' }));
  }));
  r.post('/import', h(async (req, res) => {
    const { data, mode } = req.body ?? {};
    if (mode !== undefined && mode !== 'merge' && mode !== 'replace') {
      res.status(400).json({ error: 'mode 须为 merge 或 replace' });
      return;
    }
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.rels)) {
      res.status(400).json({ error: '导入数据格式错误：需 { nodes: [], rels: [] }' });
      return;
    }
    res.json(await core.importJson(dbPathOf(), data, { mode: mode === 'replace' ? 'replace' : 'merge' }));
  }));

  return r;
}

import { randomUUID } from 'node:crypto';
import { withDb, queryAll, execBound } from './db.js';
import { ensureSchema, withRetry } from './schema.js';
import { enqueueDbOp } from './serialize.js';
import { tsParam } from './cypher.js';
import { listNodes } from './nodes.js';
import { listRels } from './rels.js';
import {
  assertAttrNames, ensureAttrColumns, NODE_SYSTEM_COLS, REL_SYSTEM_COLS,
} from './attrs.js';
import { relIdOf } from './id.js';
import { KgError } from './errors.js';

/**
 * 导入/导出节点：无 id（导入时未删条目撞库中未删同名行跳过，未命中新建；软删条目
 * 为删除指令）；时间戳字段可选（导入缺失或 'now' 取导入时刻，导出恒存在）；
 * 其余字段为平铺的动态属性（全 STRING）。
 */
export interface ExportNode {
  name: string;
  type?: string;
  description?: string;
  is_deprecate?: boolean;
  created_time?: string;
  updated_time?: string;
  deleted_time?: string | null;
  [key: string]: unknown;
}

/** 导入/导出关系：from/to 为节点 name；时间戳字段可选；其余字段平铺动态属性 */
export interface ExportRel {
  type: string;
  from: string;
  to: string;
  description?: string;
  is_deprecate?: boolean;
  created_time?: string;
  updated_time?: string;
  deleted_time?: string | null;
  [key: string]: unknown;
}

/** 导出格式即导入格式（round-trip 兼容） */
export interface ExportData {
  nodes: ExportNode[];
  rels: ExportRel[];
}

export interface ImportOptions {
  mode: 'merge' | 'replace';
}

/** 导入对象里的节点系统键（其余键视为动态属性）；id 不出现在导入格式中 */
const NODE_SYS_KEYS = new Set(
  [...NODE_SYSTEM_COLS].filter((c) => c !== 'id'),
);
const REL_SYS_KEYS = new Set(
  ['from', 'to', ...REL_SYSTEM_COLS].filter((c) => c !== 'id'),
);

/** 导入时间字段值 → timestamp($ts) 绑定参数：'now' 或缺失 → 当前时间，其余按 Date 解析 */
function tsOf(v: string | null | undefined, nowStr: string): string {
  return !v || v === 'now' ? nowStr : tsParam(new Date(v))!;
}

/**
 * 全量导出（平铺格式：无 id，动态属性直接平铺在对象上，rel 的 from/to 用节点 name）。
 * 默认只含未软删数据；includeDeleted 含全部（含 deleted_time 标记）。
 * 实现：listNodes/listRels 各自独立队列化读取（顺序执行，无锁冲突）；
 * 本函数不另包 enqueueDbOp——嵌套调用已队列化函数会死锁。
 */
export async function exportJson(
  dbPath: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<ExportData> {
  const nodes = await listNodes(dbPath, { includeDeleted: opts.includeDeleted });
  const rels = await listRels(dbPath, { includeDeleted: opts.includeDeleted });
  const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
  return {
    nodes: nodes.map((n) => ({
      name: n.name,
      type: n.type,
      description: n.description,
      is_deprecate: n.is_deprecate,
      created_time: n.created_time,
      updated_time: n.updated_time,
      deleted_time: n.deleted_time,
      ...n.attrs,
    })),
    rels: rels.map((e) => ({
      type: e.type,
      from: nameOf.get(e.from)!,
      to: nameOf.get(e.to)!,
      description: e.description,
      is_deprecate: e.is_deprecate,
      created_time: e.created_time,
      updated_time: e.updated_time,
      deleted_time: e.deleted_time,
      ...e.attrs,
    })),
  };
}

/** 导入对象 → 系统字段 + 动态属性（null 属性值跳过，与读回语义一致） */
function splitEntry(
  obj: Record<string, unknown>,
  sysKeys: Set<string>,
): { sys: Record<string, unknown>; attrs: Record<string, string> } {
  const sys: Record<string, unknown> = {};
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (sysKeys.has(k)) sys[k] = v;
    else if (v !== null && v !== undefined) attrs[k] = String(v);
  }
  return { sys, attrs };
}

/**
 * 值级预校验（须在任何写操作前——否则坏值在 merge 物理删除后才由 Kùzu 抛
 * Conversion exception，现存数据丢失）：时间戳字段须可被 Date 解析或为 'now'
 * （导入时刻，与写入路径 tsOf 同一解析；缺失或 null 跳过——deleted_time 对未
 * 软删行恒为 null）、is_deprecate 须为布尔、type/description 须为字符串。
 */
function assertEntryValues(label: string, sys: Record<string, unknown>): void {
  for (const f of ['created_time', 'updated_time', 'deleted_time'] as const) {
    const v = sys[f];
    if (v === null || v === undefined || v === 'now') continue;
    if (isNaN(new Date(v as string).getTime())) {
      throw new KgError(`${label} 的 ${f} 不是有效时间: ${String(v)}`);
    }
  }
  if (sys.is_deprecate !== undefined && typeof sys.is_deprecate !== 'boolean') {
    throw new KgError(`${label} 的 is_deprecate 不是布尔值: ${String(sys.is_deprecate)}`);
  }
  for (const f of ['type', 'description'] as const) {
    if (sys[f] !== undefined && typeof sys[f] !== 'string') {
      throw new KgError(`${label} 的 ${f} 不是字符串: ${String(sys[f])}`);
    }
  }
}

/**
 * 导入 ExportData（节点 id 创建时 randomUUID；关系 id 由端点解析结果 relIdOf(from,to,type)；
 * 时间戳保留语义：缺失或 'now' 取导入时刻）。
 * - 未删条目 = 数据：merge 下撞库（节点按未删同名行、关系按同端点同 type 的未删同 id
 *   行）→ 跳过不写；未撞 → uuid 新建。replace 清空后全为未撞。
 * - 软删条目（deleted_time 非空）= 删除指令：命中库中未删同名节点 → 软删该行（deleted_time
 *   用文件值）并级联软删其全部活跃关系（即使文件未删这些关系，与 deleteNode 语义一致）；
 *   命中同 id 未删关系 → 软删；未命中 → no-op（不新建软删行，replace 清空后亦然）。
 * - replace：先物理清空全部（边先删）再按上述规则导入。
 * rels 的 from/to 是节点 name，按未删行语义解析（文件未删条目 > merge 下库中未删行）；
 * replace 不能引用库中现存（即将清空），缺失报错。未删关系引用文件中删除的节点报错。
 * 所有校验（文件内未删 name 唯一、字段完整性、值级类型/时间戳、属性名合法性、
 * rels 引用）先于任何写操作——任一失败库零改动。写操作零命中是静默 no-op（实测），
 * 故关键写步骤后回查断言。返回值为实际新建（非跳过/指令）的节点与关系数。
 */
export async function importJson(
  dbPath: string,
  data: ExportData,
  opts: ImportOptions,
): Promise<{ nodes: number; rels: number }> {
  await ensureSchema(dbPath);
  return enqueueDbOp(dbPath, () => withRetry(() => withDb(dbPath, async (conn) => {
    // 1. 文件内节点解析：name 必填；未删条目（无 deleted_time/null）name 须唯一，
    //    软删条目允许与未删或其他软删条目同名（软删重建场景 round-trip）。
    //    值级校验（时间戳/布尔/字符串）同在此步——先于任何写操作
    const activeNames = new Set<string>();
    const nodeSpecs = data.nodes.map((raw) => {
      const { sys, attrs } = splitEntry(raw as Record<string, unknown>, NODE_SYS_KEYS);
      if (typeof sys.name !== 'string' || !sys.name) throw new KgError('节点缺少 name');
      assertEntryValues(`节点 ${sys.name}`, sys);
      const soft = sys.deleted_time != null; // 软删条目=删除指令：不参与 name 查重
      if (!soft) {
        if (activeNames.has(sys.name)) throw new KgError(`名称冲突: ${sys.name}`);
        activeNames.add(sys.name);
      }
      return { name: sys.name, sys, attrs, soft, id: '' };
    });
    assertAttrNames('Node', nodeSpecs.flatMap((s) => Object.keys(s.attrs)));

    // 2. 文件内关系解析：type/from/to 必填；值级校验同此步（端点 id 第 4 步统一解析）
    const relParsed = data.rels.map((raw) => {
      const { sys, attrs } = splitEntry(raw as Record<string, unknown>, REL_SYS_KEYS);
      for (const k of ['type', 'from', 'to'] as const) {
        if (typeof sys[k] !== 'string' || !sys[k]) throw new KgError(`关系缺少 ${k}`);
      }
      assertEntryValues(`关系 ${sys.type} ${sys.from} -> ${sys.to}`, sys);
      return { sys, attrs };
    });
    assertAttrNames('Rel', relParsed.flatMap((s) => Object.keys(s.attrs)));

    // 3. 库现状快照（merge：未删节点 name→id + 未删关系 id 集；只读）。replace
    //    无需快照（第 5 步校验全过后清空，视作空库）
    const liveDb = new Map<string, string>();
    const liveRelIds = new Set<string>();
    if (opts.mode === 'merge') {
      const rows = await queryAll(conn,
        `MATCH (n:Node) WHERE n.deleted_time IS NULL RETURN n.name AS name, n.id AS id`);
      for (const r of rows) liveDb.set(String(r['name']), String(r['id']));
      const relRows = await queryAll(conn,
        `MATCH ()-[r:Rel]->() WHERE r.deleted_time IS NULL RETURN r.id AS id`);
      for (const r of relRows) liveRelIds.add(String(r['id']));
    }

    // 4. 节点分类（软删指令按 name 去重——多条同名软删条目撞同一库行只执行一次）：
    //    未删条目撞库未删行 → 跳过（nameToId 沿用库 id，供 rels 端点解析）；
    //    未撞 → 新 uuid 插入。软删条目撞库未删行 → 删除指令；未撞 → no-op。
    const insertNodes: typeof nodeSpecs = [];
    const delNodeSpecs = new Map<string, { id: string; dt: string }>();
    const nameToId = new Map<string, string>();
    const nowStr = tsParam(new Date())!; // 导入时刻：'now' 字段与缺失时间戳统一取此值
    for (const n of nodeSpecs) {
      const liveId = liveDb.get(n.name);
      if (!n.soft) {
        if (liveId) {
          n.id = liveId;
        } else {
          n.id = randomUUID();
          insertNodes.push(n);
        }
        nameToId.set(n.name, n.id);
      } else if (liveId) {
        delNodeSpecs.set(n.name, {
          id: liveId,
          dt: tsOf(n.sys.deleted_time as string, nowStr),
        });
      }
    }
    const deadNames = new Set(delNodeSpecs.keys());
    for (const [name, id] of liveDb) if (!nameToId.has(name)) nameToId.set(name, id);

    // 5. rels 端点解析与分类。未删条目：端点须可解析（文件未删条目 > merge 下库中
    //    未删行；replace 不能引用库中现存——即将清空），且不得引用文件中删除的节点；
    //    同 id 未删关系已存在 → 跳过，否则插入。软删条目：端点可解析且同 id 未删关系
    //    存在 → 删除指令；否则 no-op（端点缺失即目标必不存在）。
    const insertRels: {
      sys: Record<string, unknown>; attrs: Record<string, string>;
      fromId: string; toId: string; id: string;
    }[] = [];
    const delRelSpecs = new Map<string, { label: string; dt: string }>();
    for (const e of relParsed) {
      const label = `${e.sys.type} ${e.sys.from} -> ${e.sys.to}`;
      const fromId = nameToId.get(e.sys.from as string);
      const toId = nameToId.get(e.sys.to as string);
      if (e.sys.deleted_time == null) {
        if (fromId === undefined || toId === undefined) {
          throw new KgError(`关系引用了不存在的节点: ${e.sys.from} -> ${e.sys.to}`);
        }
        if (deadNames.has(e.sys.from as string) || deadNames.has(e.sys.to as string)) {
          throw new KgError(`关系引用了文件中已删除的节点: ${label}`);
        }
        const id = relIdOf(fromId, toId, e.sys.type as string);
        if (!liveRelIds.has(id)) insertRels.push({ ...e, fromId, toId, id });
      } else if (fromId !== undefined && toId !== undefined) {
        const id = relIdOf(fromId, toId, e.sys.type as string);
        if (liveRelIds.has(id)) {
          delRelSpecs.set(id, {
            label,
            dt: tsOf(e.sys.deleted_time as string, nowStr),
          });
        }
      }
    }

    // 6. replace：全量物理清空（边先删——删带边节点须先删边），删后断言归零。
    //    置于全部校验后——任一校验失败库零改动
    if (opts.mode === 'replace') {
      await queryAll(conn, `MATCH ()-[r:Rel]->() DELETE r`);
      await queryAll(conn, `MATCH (n:Node) DELETE n`);
      const rc = await queryAll(conn, `MATCH ()-[r:Rel]->() RETURN count(r) AS c`);
      const nc = await queryAll(conn, `MATCH (n:Node) RETURN count(n) AS c`);
      if (Number(rc[0]['c']) > 0 || Number(nc[0]['c']) > 0) {
        throw new KgError('replace 清空失败');
      }
    }

    // 7. 删除指令（先删后插）。节点：软删 + 级联软删其全部活跃关系（出+入，即使
    //    文件未删这些关系），deleted_time 统一用文件值；断言节点无未删残留。
    //    关系：软删同 id 未删行（可能已被上级联软删——SET 无命中即已达标），
    //    断言无未删残留。
    for (const [name, d] of delNodeSpecs) {
      await execBound(conn,
        `MATCH (a:Node {id: $id})-[r:Rel]->() WHERE r.deleted_time IS NULL SET r.deleted_time = timestamp($dt)`,
        { id: d.id, dt: d.dt });
      await execBound(conn,
        `MATCH ()-[r:Rel]->(b:Node {id: $id}) WHERE r.deleted_time IS NULL SET r.deleted_time = timestamp($dt)`,
        { id: d.id, dt: d.dt });
      await execBound(conn,
        `MATCH (n:Node {id: $id}) SET n.deleted_time = timestamp($dt)`,
        { id: d.id, dt: d.dt });
      const back = await execBound(conn,
        `MATCH (n:Node {id: $id}) WHERE n.deleted_time IS NULL RETURN count(n) AS c`, { id: d.id });
      if (Number(back[0]['c']) !== 0) throw new KgError(`节点软删失败: ${name}`);
    }
    for (const [id, d] of delRelSpecs) {
      await execBound(conn,
        `MATCH ()-[r:Rel {id: $id}]->() WHERE r.deleted_time IS NULL SET r.deleted_time = timestamp($dt)`,
        { id, dt: d.dt });
      const back = await execBound(conn,
        `MATCH ()-[r:Rel {id: $id}]->() WHERE r.deleted_time IS NULL RETURN count(r) AS c`, { id });
      if (Number(back[0]['c']) !== 0) throw new KgError(`关系软删失败: ${d.label}`);
    }

    // 8. 动态列就位（ALTER ADD；属性名已在第 1/2 步预校验；仅插入集需要——指令/
    //    跳过条目不写库），然后插入节点（写后回查断言；插入集恒为未删条目，
    //    deleted_time 恒 NULL）
    const nodeAttrs: Record<string, string> = {};
    for (const s of insertNodes) Object.assign(nodeAttrs, s.attrs);
    await ensureAttrColumns(conn, 'Node', nodeAttrs);

    for (const n of insertNodes) {
      const keys = Object.keys(n.attrs);
      const attrCols = keys.map((k) => `${k}: $a_${k}`).join(', ');
      const attrParams: Record<string, unknown> = {};
      for (const k of keys) attrParams[`a_${k}`] = n.attrs[k];
      const params: Record<string, unknown> = {
        id: n.id, name: n.name,
        type: (n.sys.type as string) ?? '', descr: (n.sys.description as string) ?? '',
        ct: tsOf(n.sys.created_time as string | undefined, nowStr),
        ut: tsOf(n.sys.updated_time as string | undefined, nowStr),
        dep: n.sys.is_deprecate ?? false,
        ...attrParams,
      };
      await execBound(conn, `CREATE (n:Node {
        id: $id, name: $name, type: $type, description: $descr,
        created_time: timestamp($ct), updated_time: timestamp($ut),
        deleted_time: NULL, is_deprecate: $dep${attrCols ? `, ${attrCols}` : ''}
      })`, params);
      const back = await execBound(conn,
        `MATCH (n:Node {id: $id}) RETURN count(n) AS c`, { id: n.id });
      if (Number(back[0]['c']) !== 1) throw new KgError(`节点导入失败: ${n.name}`);
    }

    // 9. 插入边（插入集恒为未删条目，deleted_time 恒 NULL）。按 id 累计计数终检
    const relAttrs: Record<string, string> = {};
    for (const s of insertRels) Object.assign(relAttrs, s.attrs);
    await ensureAttrColumns(conn, 'Rel', relAttrs);

    const expectPerId = new Map<string, number>();
    for (const s of insertRels) expectPerId.set(s.id, (expectPerId.get(s.id) ?? 0) + 1);
    for (const e of insertRels) {
      const keys = Object.keys(e.attrs);
      const attrCols = keys.map((k) => `${k}: $a_${k}`).join(', ');
      const attrParams: Record<string, unknown> = {};
      for (const k of keys) attrParams[`a_${k}`] = e.attrs[k];
      const params: Record<string, unknown> = {
        from: e.fromId, to: e.toId, id: e.id, type: e.sys.type,
        descr: (e.sys.description as string) ?? '',
        ct: tsOf(e.sys.created_time as string | undefined, nowStr),
        ut: tsOf(e.sys.updated_time as string | undefined, nowStr),
        dep: e.sys.is_deprecate ?? false,
        ...attrParams,
      };
      await execBound(conn, `MATCH (a:Node {id: $from}), (b:Node {id: $to})
        CREATE (a)-[:Rel {id: $id, type: $type, description: $descr,
          created_time: timestamp($ct), updated_time: timestamp($ut),
          deleted_time: NULL, is_deprecate: $dep${attrCols ? `, ${attrCols}` : ''}}]->(b)`, params);
    }
    for (const [id, expect] of expectPerId) {
      const back = await execBound(conn,
        `MATCH ()-[r:Rel {id: $id}]->() RETURN count(r) AS c`, { id });
      if (Number(back[0]['c']) !== expect) throw new KgError(`关系导入失败: ${relLabel(insertRels, id)}`);
    }

    return { nodes: insertNodes.length, rels: insertRels.length };
  })));
}

/** rel id → 导入失败文案用标签（type from -> to） */
function relLabel(relSpecs: { id: string; sys: Record<string, unknown> }[], id: string): string {
  const s = relSpecs.find((x) => x.id === id)!;
  return `${s.sys.type} ${s.sys.from} -> ${s.sys.to}`;
}

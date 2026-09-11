# NanoKG (Nano Knowledge Graph)

轻量知识图谱管理系统：LadybugDB 单文件存储 + Web 管理页 + CLI。

## 安装

```bash
npm install -g @huangminhua/nanokg      # 发布后可用
npx @huangminhua/nanokg <command>       # 免安装执行
```

或从源码构建：

```bash
git clone <repo> && cd nanokg
npm install && npm run build
npm link                   # 注册全局 nanokg 命令
```

## CLI 使用

### 数据库路径

所有命令共用同一数据文件，按以下优先级定位：

1. `--db <path>` 参数
2. `NANOKG_DB` 环境变量
3. 默认 `~/.nanokg/data.lbug`

文件不存在时自动创建并初始化 schema。

```bash
nanokg --db ./my.lbug serve          # 指定库文件
NANOKG_DB=./my.lbug nanokg export out.json   # 或环境变量
```

### nanokg serve — 启动 Web 管理页

```bash
nanokg serve                  # http://localhost:3000
nanokg serve -p 8080          # 指定端口
```

同时提供 REST API（`/api/*`）与前端管理页；启动时自动初始化 schema。

### nanokg cypher — 执行 Cypher 查询

任意 openCypher，读写均可，结果以 JSON 输出：

```bash
# 全部节点
nanokg cypher "MATCH (n:Node) RETURN n.name, n.type"

# 按名称模糊搜索
nanokg cypher "MATCH (n:Node) WHERE n.name CONTAINS '订单' RETURN n"

# 某节点的全部出边及邻居
nanokg cypher "MATCH (a:Node {name: '订单系统'})-[r:Rel]->(b) RETURN b.name, r.type"
```

> 注意：节点 label 为 `Node`，关系 label 统一为 `Rel`——「关系类型」（如「调用」「依赖」）
> 是关系的 `type` 属性，不是 Cypher label。
> 手写 `CREATE` 时时间戳字段须用 `timestamp('2026-09-10T00:00:00')`（带字符串参数，零参调用不支持）。

### nanokg import — 导入 JSON

```bash
nanokg import data.json               # 默认 merge
nanokg import data.json -m replace    # 先清空再导入
```

文件格式（无 id，关系用节点名称引用端点，动态属性直接平铺）：

```json
{ "nodes": [ { "name": "订单系统", "type": "系统", "description": "", "owner": "张三" } ],
  "rels":  [ { "type": "调用", "from": "订单系统", "to": "库存接口", "freq": "daily" } ] }
```

- **merge**：节点按未删同名、关系按同端点同类型判定重复——已存在则跳过，不存在则新建
- **replace**：校验通过后物理清空全库，再按上述规则导入
- 条目带非空 `deleted_time` 视为**删除指令**（软删命中项），而非数据
- 时间戳字段可省略（默认导入时刻）；所有校验先于写入，任一项非法则整库零改动

### nanokg export — 导出 JSON

```bash
nanokg export out.json          # 未软删数据
nanokg export out.json --all    # 含已软删数据
```

导出格式与导入格式一致（round-trip 兼容），可作为备份。

### 全局选项

```bash
nanokg --version
nanokg --help
nanokg <command> --help
```

## Web 管理页

- **总览 `/`**：全图渲染（Sigma.js）。点击节点进入以其为中心的关系图；右上「导出 JSON」下载全部数据。
- **节点管理 `/nodes`**：列表 + 搜索；增删改（属性 JSON、弃用开关）；删除为软删并级联其关系；「导入」支持合并/替换。
- **关系图 `/graph/:nodeId`**：中心节点 + 可选跳数；侧栏对关系增删改，保存后图实时刷新。

## 数据模型

节点 `Node`：id（UUID）/ name（未删行唯一）/ type（如「系统」「接口」）/ description / 动态属性 / created_time / updated_time / deleted_time / is_deprecate
关系 `Rel`：id（由端点与类型哈希决定，同端点同类型幂等）/ type / from / to / description / 动态属性 + 同四审计字段。

动态属性无需预定义，直接写入（自动建列，一律字符串）；`GET /api/schema` 反射当前全部字段。删除均为软删（`deleted_time` 标记），删除节点级联软删其关系。

## 开发

```bash
npm run build        # tsc 类型检查（node + web）→ tsup 打包 → vite 构建前端
npm run serve        # API :3000 + 管理页
npm run dev          # Vite 开发服务器 :5173（/api 代理到 3000）
npm test             # 144 个用例
```

目录结构：`cli/`（CLI 入口）· `src/core`（图谱核心）· `src/server`（Express API）· `web/`（React 前端）· `test/`。

## 技术栈

LadybugDB（@ladybugdb/core 0.20.1）· Graphology · Sigma.js · React 19 + shadcn-ui + Tailwind v4 · Express · commander · Vite · TypeScript

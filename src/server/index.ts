import express, { type Express } from 'express';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { apiRouter } from './routes.js';
import { KgError } from '../core/index.js';

export interface AppOptions { dbPath: string | (() => string); webDist?: string }

export function createApp(opts: AppOptions): Express {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  const dbPathOf = typeof opts.dbPath === 'function' ? opts.dbPath : () => opts.dbPath as string;
  app.use('/api', apiRouter(dbPathOf));
  // /api 未知路径兜底：默认 404 是 HTML，统一 JSON
  app.use('/api', (_q: express.Request, res: express.Response) => {
    res.status(404).json({ error: '端点不存在' });
  });
  // 静态托管（SPA）：须在 /api 路由与 JSON 404 兜底之后——API 先注册先匹配，
  // /api/* 永远到不了这里；其余未命中路径 fallback 到 index.html（客户端路由）。
  if (opts.webDist) {
    const dist = resolve(opts.webDist);
    if (existsSync(dist)) {
      app.use(express.static(dist));
      app.get('*', (_req: express.Request, res: express.Response) => {
        res.sendFile(join(dist, 'index.html'));
      });
    }
  }
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    // 带 status 的错误（如 express.json() 解析失败 malformed JSON → 400）直接采用
    const status0 = (err as { status?: unknown }).status;
    if (typeof status0 === 'number') { res.status(status0).json({ error: msg }); return; }
    // KgError 两类：资源不存在（404） vs 输入校验（400）
    // core 错误文案约定：'节点不存在: id'/'关系不存在: id' → 404；'已存在'/'名称冲突'/'自环'/'端点不存在'/'引用了不存在' → 400
    // 404 判定须在 Parser/Binder 之前：病态 id（如含 'Parser exception' 字样）回显进错误文案时不能误判 400
    const notFoundPattern = /^(节点|关系)不存在/;
    if (notFoundPattern.test(msg)) { res.status(404).json({ error: msg }); return; }
    // Cypher 语法/绑定错误：driver 抛普通 Error，文案含 Parser/Binder exception → 400（客户端输入问题）
    if (/Parser exception|Binder exception/.test(msg)) { res.status(400).json({ error: msg }); return; }
    const status = err instanceof KgError || /已存在|冲突|自环|不存在/.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  });
  return app;
}

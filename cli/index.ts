import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createApp } from '../src/server/index.js';
import { resolveDbPath } from '../src/server/dbpath.js';
import * as core from '../src/core/index.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const program = new Command();
program
  .name('nanokg')
  .description('NanoKG 轻量知识图谱管理工具')
  .version('0.1.2')
  .option('--db <path>', 'LadybugDB 数据文件路径（默认 ~/.nanokg/data.lbug，或 NANOKG_DB 环境变量）');

program
  .command('serve')
  .description('启动 Web 管理页服务')
  .option('-p, --port <number>', '端口', '3000')
  .action(async (opts: { port: string }) => {
    const dbPath = resolveDbPath(program.opts().db);
    await core.ensureSchema(dbPath);
    const here = dirname(fileURLToPath(import.meta.url));   // dist/
    const webDist = resolve(here, 'web');                    // dist/web（包内自包含，发布后有效）
    if (!existsSync(webDist)) {
      console.warn(`（警告: 未找到 web 构建产物 ${webDist}，仅提供 API — 先运行 npm run build）`);
    }
    const app = createApp({ dbPath, webDist });
    const port = Number(opts.port);
    app.listen(port, () => {
      console.log(`NanoKG 管理页: http://localhost:${port}  (db: ${dbPath})`);
    });
  });

program
  .command('cypher')
  .description('执行 Cypher 查询')
  .argument('<cypher>', 'Cypher 语句')
  .action(async (cypher: string) => {
    const { columns, rows } = await core.queryCypher(resolveDbPath(program.opts().db), cypher);
    if (!rows.length) { console.log(columns.length ? '（无结果）' : '执行完成'); return; }
    console.log(JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2));
  });

program
  .command('import')
  .description('导入 JSON 文件')
  .argument('<file>', 'JSON 文件路径')
  .option('-m, --mode <mode>', 'merge | replace', 'merge')
  .action(async (file: string, opts: { mode: string }) => {
    if (opts.mode !== 'merge' && opts.mode !== 'replace') {
      console.error(`mode 须为 merge 或 replace（收到: ${opts.mode}）`);
      process.exitCode = 1;
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(await readFile(file, 'utf-8'));
    } catch (e) {
      console.error(`文件读取/解析失败: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
      return;
    }
    const counts = await core.importJson(resolveDbPath(program.opts().db), data as never, {
      mode: opts.mode,
    });
    console.log(`导入完成（${opts.mode}）: ${counts.nodes} 节点, ${counts.rels} 关系`);
  });

program
  .command('export')
  .description('导出 JSON 文件')
  .argument('<file>', '输出 JSON 文件路径')
  .option('--all', '包含已软删数据', false)
  .action(async (file: string, opts: { all: boolean }) => {
    const data = await core.exportJson(resolveDbPath(program.opts().db), { includeDeleted: opts.all });
    await writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`导出完成: ${data.nodes.length} 节点, ${data.rels.length} 关系 -> ${file}`);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** 优先级：--db 参数 > NANOKG_DB 环境变量 > 默认 ~/.nanokg/data.lbug */
export function resolveDbPath(cliDb?: string): string {
  if (cliDb) return resolve(cliDb);
  if (process.env.NANOKG_DB) return resolve(process.env.NANOKG_DB);
  return resolve(homedir(), '.nanokg/data.lbug');
}

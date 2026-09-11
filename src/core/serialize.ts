/** per-dbPath 进程内 DB 操作队列：同一 DB 路径的读写串行执行，消除 check-then-write TOCTOU 与读写重叠的文件锁冲突（Error 33）。 */
const queues = new Map<string, Promise<unknown>>();

export function enqueueDbOp<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(dbPath) ?? Promise.resolve();
  const run = prev.then(fn, fn); // 前序失败不阻断本任务
  queues.set(dbPath, run.catch(() => {}));
  return run;
}

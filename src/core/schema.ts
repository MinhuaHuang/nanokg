import { withDb, queryAll } from './db.js';

// 动态属性 = 运行时 ALTER TABLE ADD <col> STRING 列（见 attrs.ts），DDL 里无 properties 列
const DDL = [
  `CREATE NODE TABLE Node(
    id STRING PRIMARY KEY,
    name STRING,
    type STRING,
    description STRING,
    created_time TIMESTAMP,
    updated_time TIMESTAMP,
    deleted_time TIMESTAMP,
    is_deprecate BOOLEAN
  )`,
  // 实测 LadyBugDB 语法：FROM/TO 必须在列首，属性列在后
  `CREATE REL TABLE Rel(
    FROM Node TO Node,
    id STRING,
    type STRING,
    description STRING,
    created_time TIMESTAMP,
    updated_time TIMESTAMP,
    deleted_time TIMESTAMP,
    is_deprecate BOOLEAN
  )`,
];

const schemaReady = new Set<string>(); // 进程内标记，避免重复 DDL

/** 写操作重试：并发 open 锁冲突时退避重试（实测文案 "IO exception: Could not set lock on file"） */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err).toLowerCase();
      // 精确匹配文件锁文案：泛 lock/conflict 会误吞含 "locksmith" 等用户数据的错误
      if (!msg.includes('could not set lock') || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    }
  }
  throw lastErr;
}

export async function ensureSchema(dbPath: string): Promise<void> {
  if (schemaReady.has(dbPath)) return;
  // 并发冷启动：首次建库可能撞文件锁（Error 33），须退避重试
  await withRetry(() => withDb(dbPath, async (conn) => {
    for (const ddl of DDL) {
      try {
        await queryAll(conn, ddl);
      } catch (err) {
        const msg = String(err);
        if (!msg.includes('already exists')) throw err;
      }
    }
  }));
  schemaReady.add(dbPath);
}

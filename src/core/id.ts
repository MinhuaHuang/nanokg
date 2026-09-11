import { createHash } from 'node:crypto';

/** base64url(sha256(input))，43 字符 */
export function hashId(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64url');
}

/** 关系 id 由 (fromId, toId, type) 确定性生成（同端点同类型同 id）。
 * 节点 id 不再由 name 派生——创建时 randomUUID()（见 nodes.ts），改名/软删重建均不受 hash 约束。 */
export const relIdOf = (fromId: string, toId: string, type: string) =>
  hashId(`${fromId}|${toId}|${type}`);

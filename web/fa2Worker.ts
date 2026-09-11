// FA2 布局 Web Worker：主线程用 graphToByteArrays 序列化图矩阵后 transfer 进来，
// worker 内分块迭代（iterate 原地改矩阵——与主线程版 forceAtlas2.assign 同一实现，
// 布局结果一致），每块回传一次坐标快照。主线程 rAF 覆盖式消费快照（旧快照直接丢弃），
// 布局期间主线程不参与计算——4718 节点实测主线程同步跑为 212ms/帧（页面冻结），
// 移入 worker 后由每帧一次的快照写回（毫秒级）取代。
import iterate from 'graphology-layout-forceatlas2/iterate';
import DEFAULT_SETTINGS from 'graphology-layout-forceatlas2/defaults';

export interface Fa2StartMessage {
  nodes: ArrayBuffer; // PPN=10 列节点矩阵（graphToByteArrays 输出，transfer 后归 worker）
  edges: ArrayBuffer; // PPE=3 列边矩阵
  settings: Record<string, unknown>;
  totalIters: number;
  chunk: number; // 每块迭代数：块间隔 ≈ chunk×单迭代耗时，即布局动画的快照间隔
}

export interface Fa2SnapshotMessage {
  done: boolean; // 是否已到 totalIters（最后一个快照）
  xy: ArrayBuffer; // N×2 float，按 graphToByteArrays 时的节点行序（worker 不重排）
}

const PPN = 10; // 与 helpers.graphToByteArrays 的节点矩阵行宽一致

// DOM lib 不含 DedicatedWorkerGlobalScope，做最小局部声明（避免 DOM/Worker lib 全局冲突）
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Fa2StartMessage>) => void) | null;
  postMessage: (message: Fa2SnapshotMessage, transfer: Transferable[]) => void;
};

ctx.onmessage = (e) => {
  const { nodes, edges, totalIters, chunk } = e.data;
  // merge 默认设置（slowDown/barnesHutTheta 等 10 项）：iterate 直接裸调用缺这些字段
  // 会算出 NaN（nodespeed/undefined）——assign/supervisor 内部同样先 merge defaults
  const settings = { ...DEFAULT_SETTINGS, ...e.data.settings };
  const N = new Float32Array(nodes);
  const E = new Float32Array(edges);
  for (let done = 0; done < totalIters; ) {
    const n = Math.min(chunk, totalIters - done);
    for (let i = 0; i < n; i++) iterate(settings, N, E);
    done += n;
    // 快照只取每行前 2 列（x,y），传输体积 1/5
    const xy = new Float32Array((N.length / PPN) * 2);
    for (let i = 0, k = 0; i < N.length; i += PPN, k += 2) {
      xy[k] = N[i];
      xy[k + 1] = N[i + 1];
    }
    ctx.postMessage({ done: done >= totalIters, xy: xy.buffer }, [xy.buffer]);
  }
};

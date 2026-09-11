// graphology-layout-forceatlas2 的子模块为 CJS 且不带类型声明，这里补最小签名。
// 运行时由 Vite（esbuild/rollup 的 CJS interop）把 module.exports 映射为 default 导出。
declare module 'graphology-layout-forceatlas2/iterate' {
  const iterate: (
    settings: Record<string, unknown>,
    nodes: Float32Array,
    edges: Float32Array,
  ) => void;
  export default iterate;
}

declare module 'graphology-layout-forceatlas2/defaults' {
  const DEFAULT_SETTINGS: Record<string, unknown>;
  export default DEFAULT_SETTINGS;
}

declare module 'graphology-layout-forceatlas2/helpers' {
  import type Graph from 'graphology';
  export function graphToByteArrays(
    graph: Graph,
    getEdgeWeight: (
      edge: unknown,
      attrs: Record<string, unknown>,
      source: unknown,
      target: unknown,
      sourceAttrs: Record<string, unknown>,
      targetAttrs: Record<string, unknown>,
      undirected: boolean,
    ) => number,
  ): { nodes: Float32Array; edges: Float32Array };
}

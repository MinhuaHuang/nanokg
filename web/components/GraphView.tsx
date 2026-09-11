import { useEffect, useMemo, useRef } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { EdgeArrowProgram } from 'sigma/rendering';
import { createNodeImageProgram } from '@sigma/node-image';
import {
  createEdgeCurveProgram, createDrawCurvedEdgeLabel, DEFAULT_EDGE_CURVE_PROGRAM_OPTIONS,
  DEFAULT_EDGE_CURVATURE, indexParallelEdgesIndex,
} from '@sigma/edge-curve';

// node-image 节点盘渲染 = size×4（其 shader gl_PointSize 乘 4），边程序认知的 targetSize
// 仍按 ×1 → 默认箭头环带（thickness×2.5）全被盘盖住。加大箭头比例让环带伸出盘边（harness 实测）。
// drawLabel 挂在曲线程序上（sigma 全局 defaultDrawEdgeLabel 用默认 — 直线标签贴合线中点，
// 曲线 label 函数给直线画会按曲线几何偏移出去）。
const CurvedArrowProgram = createEdgeCurveProgram({
  ...DEFAULT_EDGE_CURVE_PROGRAM_OPTIONS,
  arrowHead: { extremity: 'target', lengthToThicknessRatio: 10, widenessToThicknessRatio: 2.7 },
  drawLabel: createDrawCurvedEdgeLabel(DEFAULT_EDGE_CURVE_PROGRAM_OPTIONS),
});
import type { NodeRecord, RelRecord } from '../types';
import { typeColor, UNCATEGORIZED } from '../graphColors';
import { NodeTypeIcon, nodeIconDataUrl } from '../nodeIcon';

/** 官方 parallel-edges story 的曲率公式：指数饱和递增，避免多条时过度弯曲 */
function parallelCurvature(index: number, maxIndex: number): number {
  if (maxIndex <= 0) throw new Error('Invalid maxIndex');
  if (index < 0) return -parallelCurvature(-index, maxIndex);
  const amplitude = 3.5;
  const maxCurvature = amplitude * (1 - Math.exp(-maxIndex / amplitude)) * DEFAULT_EDGE_CURVATURE;
  return (maxCurvature * index) / maxIndex;
}

interface Props {
  nodes: NodeRecord[];
  edges: RelRecord[];
  centerId?: string; // 高亮中心节点（橙色 + 呼吸动效）
  typeFilter?: Set<string>; // 类型多选筛选（空集/缺省 = 不过滤）
  onNodeClick?: (id: string) => void;
}

/** 类型过滤：节点按 type（空 type 归入 UNCATEGORIZED）保留，边两端都在保留集才显示。
 *  导出供页面复用（侧栏计数等需与图内可见集合一致）。 */
export function filterGraphByType(
  nodes: NodeRecord[],
  edges: RelRecord[],
  typeFilter?: Set<string>,
): { nodes: NodeRecord[]; edges: RelRecord[] } {
  if (!typeFilter || typeFilter.size === 0) return { nodes, edges };
  const kept = nodes.filter((n) => typeFilter.has(n.type || UNCATEGORIZED));
  const ids = new Set(kept.map((n) => n.id));
  return { nodes: kept, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

/** sigma 封装：ForceAtlas2 力导向布局（相近关系节点聚簇）；节点按类型着色（弃用/软删/中心语义色优先）；数据变更时重建 */
export default function GraphView({ nodes, edges, centerId, typeFilter, onNodeClick }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const clickRef = useRef(onNodeClick);
  clickRef.current = onNodeClick;

  const filtered = useMemo(() => filterGraphByType(nodes, edges, typeFilter), [nodes, edges, typeFilter]);

  // 图例类型：过滤后出现的类型（首现顺序）
  const legendTypes = useMemo(() => {
    const seen: string[] = [];
    for (const n of filtered.nodes) {
      const t = n.type || UNCATEGORIZED;
      if (!seen.includes(t)) seen.push(t);
    }
    return seen;
  }, [filtered]);

  useEffect(() => {
    if (!ref.current || filtered.nodes.length === 0) return;
    const graph = new Graph({ multi: true, type: 'directed' });
    const R = 100;
    // 删除/弃用节点保持类型色，仅降透明度（删除更淡）
    const withAlpha = (hex: string, alpha: number) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    // 度数（过滤后边的出+入计数）：关系越多节点越大，枢纽/疏密一眼可辨
    //（等大小时孤立节点与 hub 视觉平权，看不出疏密）。
    const degree = new Map<string, number>();
    const nodeIds = new Set(filtered.nodes.map((n) => n.id));
    for (const e of filtered.edges) {
      if (nodeIds.has(e.from) && nodeIds.has(e.to)) {
        degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
        degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
      }
    }
    // 度数（过滤后边的出+入计数）→ 节点大小：孤立 6，按 √度数连续增长封顶 24。
    const sizeOf = (id: string) => Math.min(24, 6 + 1.8 * Math.sqrt(degree.get(id) ?? 0));
    const showLabels = filtered.nodes.length <= 20;
    filtered.nodes.forEach((n, i) => {
      const a = (2 * Math.PI * i) / filtered.nodes.length;
      const base = typeColor(n.type);
      graph.addNode(n.id, {
        // 标签默认显隐按图规模：节点 >20 默认全部不显示名称（节点多的标签
        // 必然互相压盖），hover 临时补显（enterNode/leaveNode）；≤20 正常显示。
        label: showLabels ? n.name : '',
        type: 'image', // 节点渲染走 image program：类型色圆底 + 白色 icon 叠加
        image: nodeIconDataUrl(n.type),
        x: R * Math.cos(a),
        y: R * Math.sin(a),
        size: sizeOf(n.id), // 中心节点不再强制放大：呼吸动效已足够突出，大小仍按度数
        color: n.deleted_time ? withAlpha(base, 0.25)
          : n.is_deprecate ? withAlpha(base, 0.45)
          : base,
      });
    });
    // 边先于布局加入：FA2 弹簧力须真实参与迭代，相连节点才会聚簇（曾错置于布局后，
    // 图收敛成与关系无关的均匀圆盘——看不出疏密的根因）。
    filtered.edges.forEach((e) => {
      if (graph.hasNode(e.from) && graph.hasNode(e.to)) {
        graph.addEdgeWithKey(e.id, e.from, e.to, {
          size: 2, // 细线；箭头绝对尺寸由程序 ratio 保证（见 CurvedArrowProgram 注释）
          // 弃用边淡灰（实色）；删除边更淡。
          // 注意：边 WebGL 程序对带 alpha 的颜色（rgba()/8位hex）实测整边丢弃，只能用实色。
          color: e.deleted_time ? '#e2e8f0' : e.is_deprecate ? '#cbd5e1' : '#94a3b8',
          type: 'straight',
          label: '', // hover 时才填类型（enterEdge/leaveEdge）
        });
      }
    });
    // 平行边处理（对齐官方 edge-curve parallel-edges story）：
    // 唯一边直线箭头；同向平行组 index 0 直线、其余正向递增弯曲；双向组正负对称弯曲。
    // 注意：edge-curve 的贝塞尔 SDF 对 curvature=0 退化 NaN 整边丢弃，0 曲率边必须用直线程序。
    indexParallelEdgesIndex(graph);
    graph.forEachEdge((edge, attrs) => {
      const { parallelIndex, parallelMinIndex, parallelMaxIndex } = attrs as {
        parallelIndex?: number | null;
        parallelMinIndex?: number | null;
        parallelMaxIndex?: number | null;
      };
      if (typeof parallelMinIndex === 'number') {
        // 同向平行组：index 0 直线，其余弯曲
        graph.mergeEdgeAttributes(edge, {
          type: parallelIndex ? 'curved' : 'straight',
          curvature: parallelCurvature(parallelIndex as number, parallelMaxIndex as number),
        });
      } else if (typeof parallelIndex === 'number') {
        // 双向平行组：正负对称弯曲
        graph.mergeEdgeAttributes(edge, {
          type: 'curved',
          curvature: parallelCurvature(parallelIndex, parallelMaxIndex as number),
        });
      } else {
        graph.setEdgeAttribute(edge, 'type', 'straight');
      }
    });
    const sigma = new Sigma(graph, ref.current, {
      renderEdgeLabels: true, // 引擎按 label 有无绘制 — 空 label 不画
      edgeLabelSize: 11,
      enableEdgeEvents: true, // 边 hover 事件（sigma v3 默认关闭，不开则 enterEdge 不触发）
      doubleClickZoomingRatio: 1, // 禁用双击缩放（动画到原比例 = 无操作）；缩放仅滚轮
      edgeProgramClasses: {
        straight: EdgeArrowProgram,
        curved: CurvedArrowProgram,
      },
      nodeProgramClasses: {
        // background 模式：节点 color 作圆底，icon 图按 alpha 叠加（padding 留出圆边）
        image: createNodeImageProgram({ padding: 0.2 }),
      },
    });
    // 小图不拉满视口：autoRescale 把全图 bbox 映射整个视口——两个节点必然分居两端、
    // 隔老远。customBBox 给归一化框设下限（半边 ≥1.5×平均边长，按视口宽高比扩另半边
    // 防拉伸），内容聚在框内视觉紧凑；大图 bbox 本就远超下限，行为不变。
    // 布局逐帧演化，每帧重算让视图跟随。
    const applyBBox = () => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, sumLen = 0;
      graph.forEachNode((_n, a) => {
        const x = a.x as number, y = a.y as number;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      });
      graph.forEachEdge((_e, _a, _s, _t, sa, ta) => {
        sumLen += Math.hypot((sa.x as number) - (ta.x as number), (sa.y as number) - (ta.y as number));
      });
      const avgLen = graph.size ? sumLen / graph.size : 0;
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      let ex = Math.max((maxX - minX) / 2, avgLen * 1.5, 1);
      let ey = Math.max((maxY - minY) / 2, avgLen * 1.5, 1);
      const aspect = ref.current!.clientWidth / ref.current!.clientHeight;
      if (ex / ey < aspect) ex = ey * aspect; else ey = ex / aspect;
      sigma.setCustomBBox({ x: [cx - ex, cx + ex], y: [cy - ey, cy + ey] });
    };
    applyBBox();
    sigma.on('clickNode', ({ node }) => clickRef.current?.(node));
    // hover 边：显示类型标签 + 加粗；移开还原
    const edgeType = new Map(filtered.edges.map((e) => [e.id, e.type]));
    sigma.on('enterEdge', ({ edge }) => {
      graph.setEdgeAttribute(edge, 'label', edgeType.get(String(edge)) ?? '');
      graph.setEdgeAttribute(edge, 'size', 4);
      sigma.refresh();
    });
    sigma.on('leaveEdge', ({ edge }) => {
      graph.setEdgeAttribute(edge, 'label', '');
      graph.setEdgeAttribute(edge, 'size', 2);
      sigma.refresh();
    });
    // hover 节点：其直接关联的边（出+入）加粗 + 显示类型；移开还原
    //（sigma 在节点 hover 时不做边命中检测，两套事件不冲突）
    const highlightEdgesOf = (node: string, on: boolean) => {
      for (const e of graph.edges(node)) {
        graph.setEdgeAttribute(e, 'label', on ? (edgeType.get(String(e)) ?? '') : '');
        graph.setEdgeAttribute(e, 'size', on ? 4 : 2);
      }
      sigma.refresh();
    };
    // hover 节点：临时补显名称（孤立节点默认无标签）+ 其直接关联的边（出+入）加粗
    // + 显示类型；移开还原默认标签（有边节点仍显示名称）（sigma 在节点 hover 时不做
    // 边命中检测，两套事件不冲突）
    const nameOf = new Map(filtered.nodes.map((n) => [n.id, n.name]));
    const labelOf = (id: string) => (showLabels ? nameOf.get(id) : '') ?? '';
    sigma.on('enterNode', ({ node }) => {
      graph.setNodeAttribute(node, 'label', nameOf.get(String(node)) ?? '');
      highlightEdgesOf(node, true);
    });
    sigma.on('leaveNode', ({ node }) => {
      graph.setNodeAttribute(node, 'label', labelOf(String(node)));
      highlightEdgesOf(node, false);
    });
    // 中心节点呼吸动效：大小 14±3 脉动，逐帧 refresh（本地小图可接受）
    let raf = 0;
    if (centerId && graph.hasNode(centerId)) {
      const t0 = performance.now();
      const base = sizeOf(centerId);
      const tick = (t: number) => {
        graph.setNodeAttribute(centerId, 'size', base + 3 * Math.sin((t - t0) / 300));
        sigma.refresh();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    // 渐进式 FA2 布局：分帧迭代替代一次性同步 assign——2000+ 节点同步 500 迭代实测
    // 3s+ 主线程卡死；分帧后首帧即见初始圆环，布局逐帧演化（~30 帧），全程可交互。
    // adjustSizes 节点尺寸参与斥力减少叠压；scalingRatio 调大拉开间距（实测 linLog 模式
    // 会把单连通图压成死团并甩飞外围节点，弃用）；gravity 偏低调（大量孤立/弱连节点
    // 在高 gravity 下会被均匀摊成圆形噪声背景，压扁稠密簇的疏密对比）。
    // 大图迭代减为 300：FA2 前段收敛快，2000+ 节点下 300 与 500 视觉差异小。
    const totalIters = graph.order > 1000 ? 300 : 500;
    const step = Math.max(2, Math.ceil(totalIters / 30));
    let iter = 0;
    let rafLayout = 0;
    const layoutStep = () => {
      forceAtlas2.assign(graph, {
        iterations: Math.min(step, totalIters - iter),
        settings: {
          adjustSizes: true,
          gravity: 0.4,
          scalingRatio: 12,
          barnesHutOptimize: graph.order > 200,
        },
      });
      iter += step;
      applyBBox();
      sigma.refresh();
      if (iter < totalIters) rafLayout = requestAnimationFrame(layoutStep);
    };
    rafLayout = requestAnimationFrame(layoutStep);

    return () => {
      if (rafLayout) cancelAnimationFrame(rafLayout);
      if (raf) cancelAnimationFrame(raf);
      sigma.kill();
    };
  }, [filtered, centerId]);

  if (filtered.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {nodes.length === 0 ? '暂无节点数据（先到节点管理页添加）' : '当前类型筛选无匹配节点'}
      </div>
    );
  }
  return (
    <div className="relative h-full w-full">
      <div ref={ref} className="h-full w-full" />
      {legendTypes.length > 0 && (
        <div className="absolute bottom-2 left-2 flex flex-col gap-1 rounded bg-background/80 p-2 text-xs">
          {legendTypes.slice(0, 10).map((t) => (
            <div key={t} className="flex items-center gap-1.5">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: typeColor(t === UNCATEGORIZED ? '' : t) }}
              />
              <NodeTypeIcon type={t === UNCATEGORIZED ? '' : t} className="size-3 shrink-0 text-muted-foreground" />
              {t === UNCATEGORIZED ? '未分类' : t}
            </div>
          ))}
          {legendTypes.length > 10 && <span className="text-muted-foreground">…</span>}
        </div>
      )}
    </div>
  );
}

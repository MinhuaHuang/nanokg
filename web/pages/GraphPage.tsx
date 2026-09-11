import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import GraphView, { filterGraphByType } from '../components/GraphView';
import RelFormDialog from '../components/RelFormDialog';
import FilterSwitches from '../components/FilterSwitches';
import TypeMultiPicker from '../components/TypeMultiPicker';
import { api, ApiError } from '../api';
import { UNCATEGORIZED } from '../graphColors';
import type { GraphData, RelRecord } from '../types';

const DEPTHS = [
  { value: '1', label: '1 跳' },
  { value: '2', label: '2 跳' },
  { value: '3', label: '3 跳' },
  { value: '5', label: '5 跳' },
  { value: 'all', label: '不限' },
];

export default function GraphPage() {
  const { nodeId } = useParams<{ nodeId: string }>();
  const navigate = useNavigate();
  const [depth, setDepth] = useState<string>('5');      // 设计：默认 5 跳（与 server 默认一致）
  const [includeDeprecate, setIncludeDeprecate] = useState(true);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [typeSel, setTypeSel] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<string[]>([]);
  const [missing, setMissing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingRel, setEditingRel] = useState<RelRecord | null>(null);
  const [deletingRel, setDeletingRel] = useState<RelRecord | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    api.getTypes().then(setTypes).catch(() => setTypes([]));
  }, []);

  // 类型筛选选项：已有类型 + 图数据存在空 type 节点时追加「未分类」
  const typeOptions = useMemo(() => {
    const opts = types.map((t) => ({ key: t, label: t }));
    if (graph?.nodes.some((n) => !n.type)) opts.push({ key: UNCATEGORIZED, label: '未分类' });
    return opts;
  }, [types, graph]);

  const refresh = useCallback(async () => {
    if (!nodeId) return;
    const seq = ++seqRef.current; // 深度切换/点击节点连发时只取最后一次
    try {
      const g = await api.getGraphAround(nodeId, depth === 'all' ? 'all' : Number(depth), {
        includeDeprecate, includeDeleted,
      });
      if (seq !== seqRef.current) return;
      setGraph(g);
      setMissing(false);
    } catch (e) {
      if (seq !== seqRef.current) return;
      if (e instanceof ApiError && e.status === 404) {
        // header 已显示「节点不存在」，不再弹 toast（uuid 泄露无意义）
        setGraph({ nodes: [], edges: [] });
        setMissing(true);
        return;
      }
      toast.error(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [nodeId, depth, includeDeprecate, includeDeleted]);

  // 侧栏与图内可见集合一致：同一过滤逻辑（类型多选）
  const visibleEdges = useMemo(
    () => filterGraphByType(graph?.nodes ?? [], graph?.edges ?? [], typeSel).edges,
    [graph, typeSel],
  );

  useEffect(() => { void refresh(); }, [refresh]);

  async function confirmDeleteRel() {
    if (!deletingRel) return;
    try {
      await api.deleteRel(deletingRel.id);
      toast.success('关系已删除');
      setDeletingRel(null);
      void refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '删除失败');
    }
  }

  // 软删关系恢复：级联恢复软删端点节点（先节点后关系，server 端处理）
  async function handleRestoreRel(r: RelRecord) {
    try {
      await api.restoreRel(r.id);
      toast.success(`已恢复「${r.type}」关系`);
      void refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '恢复失败');
    }
  }

  const nameOf = (id: string) => graph?.nodes.find((n) => n.id === id)?.name ?? id;
  const center = graph?.nodes.find((n) => n.id === nodeId);

  // 导出当前图所见数据（含类型筛选）：导出格式与总览页一致（无 id、attrs 平铺、rel from/to 用 name）
  function handleExport() {
    if (!graph) return;
    const visible = filterGraphByType(graph.nodes, graph.edges, typeSel);
    const data = {
      nodes: visible.nodes.map((n) => ({
        name: n.name, type: n.type, description: n.description,
        is_deprecate: n.is_deprecate,
        created_time: n.created_time, updated_time: n.updated_time, deleted_time: n.deleted_time,
        ...n.attrs,
      })),
      rels: visible.edges.map((e) => ({
        type: e.type, from: nameOf(e.from), to: nameOf(e.to),
        description: e.description, is_deprecate: e.is_deprecate,
        created_time: e.created_time, updated_time: e.updated_time, deleted_time: e.deleted_time,
        ...e.attrs,
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nanokg-graph-${center?.name ?? nodeId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`导出完成：${data.nodes.length} 节点 / ${data.rels.length} 关系`);
  }

  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col">
        <div className="flex items-center gap-3 px-6 py-2">
          <span className="text-sm font-medium">
            {center ? `中心：${center.name}` : (missing ? '节点不存在' : '加载中…')}
          </span>
          <Select value={depth} onValueChange={setDepth}>
            <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DEPTHS.map((d) => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <TypeMultiPicker selected={typeSel} options={typeOptions} onChange={setTypeSel} />
          <FilterSwitches
            includeDeprecate={includeDeprecate}
            includeDeleted={includeDeleted}
            onChange={(patch) => {
              if (patch.includeDeprecate !== undefined) setIncludeDeprecate(patch.includeDeprecate);
              if (patch.includeDeleted !== undefined) setIncludeDeleted(patch.includeDeleted);
            }}
          />
          <Button variant="outline" size="sm" className="ml-auto" onClick={handleExport}>导出 JSON</Button>
          <span className="text-xs text-muted-foreground">点击节点切换中心</span>
        </div>
        <div className="flex-1">
          {graph && (
            <GraphView
              nodes={graph.nodes}
              edges={graph.edges}
              centerId={nodeId}
              typeFilter={typeSel}
              onNodeClick={(id) => navigate(`/graph/${id}`)}
            />
          )}
        </div>
      </div>

      <div className="flex w-96 flex-col border-l">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-medium">关系（{visibleEdges.length}）</span>
          <Button size="sm" onClick={() => { setEditingRel(null); setFormOpen(true); }}>添加关系</Button>
        </div>
        <Separator />
        <div className="flex-1 overflow-auto p-2">
          {visibleEdges.map((r) => (
            <div key={r.id} className="mb-2 rounded-md border p-2 text-sm">
              <div className="flex items-center gap-1 font-medium">
                {r.type}
                {r.deleted_time && <Badge variant="destructive">已删除</Badge>}
              </div>
              <div className="text-xs text-muted-foreground">
                {nameOf(r.from)} → {nameOf(r.to)}
                {r.is_deprecate ? '（已弃用）' : ''}
              </div>
              <div className="mt-1 flex gap-1">
                {r.deleted_time ? (
                  <Button variant="ghost" size="sm" onClick={() => void handleRestoreRel(r)}>恢复</Button>
                ) : (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => { setEditingRel(r); setFormOpen(true); }}>编辑</Button>
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeletingRel(r)}>
                      删除
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
          {graph && visibleEdges.length === 0 && (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {typeSel.size > 0 && (graph?.edges.length ?? 0) > 0 ? '当前类型筛选下无关系' : '该范围内无关系'}
            </div>
          )}
        </div>
      </div>

      <RelFormDialog
        open={formOpen}
        rel={editingRel}
        centerId={nodeId ?? ''}
        graph={graph ?? { nodes: [], edges: [] }}
        onClose={() => setFormOpen(false)}
        onSaved={() => void refresh()}
      />

      <AlertDialog open={!!deletingRel} onOpenChange={(v) => !v && setDeletingRel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除关系「{deletingRel?.type}」？</AlertDialogTitle>
            <AlertDialogDescription>
              将软删除该关系，默认视图不再显示。导出时可用「包含已删除」取回。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDeleteRel()}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import GraphView from '../components/GraphView';
import FilterSwitches from '../components/FilterSwitches';
import TypeMultiPicker from '../components/TypeMultiPicker';
import { api, ApiError } from '../api';
import { UNCATEGORIZED } from '../graphColors';
import type { GraphData } from '../types';

export default function OverviewPage() {
  const [data, setData] = useState<GraphData | null>(null);
  const [filters, setFilters] = useState({ includeDeprecate: true, includeDeleted: false });
  const [typeSel, setTypeSel] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<string[]>([]);
  const navigate = useNavigate();
  const seqRef = useRef(0);

  useEffect(() => {
    api.getTypes().then(setTypes).catch(() => setTypes([]));
  }, []);

  // 类型筛选选项：已有类型 + 图数据存在空 type 节点时追加「未分类」
  const typeOptions = useMemo(() => {
    const opts = types.map((t) => ({ key: t, label: t }));
    if (data?.nodes.some((n) => !n.type)) opts.push({ key: UNCATEGORIZED, label: '未分类' });
    return opts;
  }, [types, data]);

  // 查询条件变化即重拉；旧图保持显示，新数据到达后替换
  useEffect(() => {
    const seq = ++seqRef.current;
    api.getGraph(filters)
      .then((g) => { if (seq === seqRef.current) setData(g); })
      .catch((e) => {
        if (seq === seqRef.current) toast.error(e instanceof ApiError ? e.message : '加载失败');
      });
  }, [filters]);

  async function handleExport() {
    try {
      const exported = await api.exportJson();
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'nanokg-export.json';
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`导出完成：${exported.nodes.length} 节点 / ${exported.rels.length} 关系`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '导出失败');
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-6 py-2">
        <div className="text-sm text-muted-foreground">
          {data ? `${data.nodes.length} 节点 · ${data.edges.length} 关系 · 点击节点进入关系图` : '加载中…'}
        </div>
        <div className="flex items-center gap-3">
          <FilterSwitches
            includeDeprecate={filters.includeDeprecate}
            includeDeleted={filters.includeDeleted}
            onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
          />
          <TypeMultiPicker selected={typeSel} options={typeOptions} onChange={setTypeSel} />
        </div>
        <Button onClick={handleExport} variant="outline">导出 JSON</Button>
      </div>
      <div className="flex-1">
        {data ? (
          <GraphView nodes={data.nodes} edges={data.edges} typeFilter={typeSel} onNodeClick={(id) => navigate(`/graph/${id}`)} />
        ) : (
          <Skeleton className="h-full w-full" />
        )}
      </div>
    </div>
  );
}

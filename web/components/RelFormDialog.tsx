import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ArrowLeftRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import type { GraphData, NodeRecord, RelRecord } from '../types';
import NodePicker from './NodePicker';
import NodeMultiPicker from './NodeMultiPicker';

interface AttrRow { name: string; value: string; isNew: boolean }

interface Props {
  open: boolean;
  rel: RelRecord | null;      // null = 新增
  centerId: string;           // 新增时默认源节点
  graph: GraphData;           // 图内节点（NodePicker 初始显示）
  onClose: () => void;
  onSaved: () => void;
}

export default function RelFormDialog({ open, rel, centerId, graph, onClose, onSaved }: Props) {
  const [type, setType] = useState('');
  const [description, setDescription] = useState('');
  const [attrRows, setAttrRows] = useState<AttrRow[]>([]);
  const [addingField, setAddingField] = useState(false);
  const [fieldName, setFieldName] = useState('');
  const [from, setFrom] = useState<string | null>(null);
  const [tos, setTos] = useState<NodeRecord[]>([]);
  const [reverse, setReverse] = useState(false); // 方向：false 中心→目标，true 目标→中心
  const [isDeprecate, setIsDeprecate] = useState(false);
  const [saving, setSaving] = useState(false);

  const asNode = (id: string | null) => graph.nodes.find((n) => n.id === id) ?? null;

  useEffect(() => {
    if (!open) return;
    setType(rel?.type ?? '');
    setDescription(rel?.description ?? '');
    setFrom(rel?.from ?? centerId);
    setTos(rel ? [asNode(rel.to)].filter((n): n is NodeRecord => !!n) : []);
    setReverse(false);
    setIsDeprecate(rel?.is_deprecate ?? false);
    setAddingField(false);
    setFieldName('');
    // 仅渲染该关系已有且非空的 attrs；空值/null 行不显示（需要时「添加字段」）
    const attrs = rel?.attrs ?? {};
    setAttrRows(
      Object.entries(attrs)
        .filter(([, v]) => v !== null && v !== '')
        .map(([k, v]) => ({ name: k, value: v ?? '', isNew: false })),
    );
  }, [open, rel, centerId]);

  function confirmAddField() {
    const n = fieldName.trim();
    if (!/^[A-Za-z0-9_]+$/.test(n)) { toast.error('字段名仅限字母、数字、下划线'); return; }
    if (attrRows.some((r) => r.name === n)) { toast.error(`字段「${n}」已存在`); return; }
    setAttrRows((rows) => [...rows, { name: n, value: '', isNew: true }]);
    setFieldName('');
    setAddingField(false);
  }

  async function handleSave() {
    if (!type.trim()) { toast.error('关系类型必填'); return; }
    if (!from || tos.length === 0) { toast.error('请选择源节点与目标节点'); return; }
    if (from === tos[0].id && tos.length === 1) { toast.error('不支持自环关系'); return; }
    // 自环目标静默剔除（多选里混入源节点时只跳过不整单失败）
    const targets = tos.map((t) => t.id).filter((id) => id !== from);
    // 空串值也提交（清空语义）；仅过滤未命名字段
    const attrs = Object.fromEntries(attrRows.filter((r) => r.name).map((r) => [r.name, r.value]));
    setSaving(true);
    try {
      if (rel) {
        // updateRel 不支持改端点，from/to 仅在新增时提交
        await api.updateRel(rel.id, { type: type.trim(), description, attrs, is_deprecate: isDeprecate });
        toast.success('关系已更新');
      } else {
        // 并行发起，server 端 enqueueDbOp 串行落库；部分失败不影响已成功条目。
        // reverse 时方向翻转：目标 → 中心（from/to 逐对交换）
        const results = await Promise.allSettled(targets.map((to) =>
          api.createRel({
            type: type.trim(), from: reverse ? to : from, to: reverse ? from : to,
            description, attrs, is_deprecate: isDeprecate,
          })));
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        if (ok > 0) toast.success(`已创建 ${ok} 条关系`);
        if (failed) {
          toast.error(failed.reason instanceof ApiError
            ? `${targets.length - ok} 条失败：${failed.reason.message}`
            : '部分关系创建失败');
        }
        if (ok === 0) return; // 全失败：不关窗，便于修改后重试
      }
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{rel ? '编辑关系' : '添加关系'}</DialogTitle></DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="rel-type">类型</Label>
            <Input id="rel-type" value={type} onChange={(e) => setType(e.target.value)} placeholder="如 knows / belongs_to" />
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>{reverse ? '目标节点 → 源节点' : '源节点 → 目标节点'}</Label>
              {!rel && (
                <Button
                  variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs"
                  onClick={() => setReverse((v) => !v)}
                >
                  <ArrowLeftRight className="size-3.5" />
                  切换方向
                </Button>
              )}
            </div>
            <NodePicker value={asNode(from)} onChange={() => {}} placeholder="源节点" disabled />
            <NodeMultiPicker
              values={tos} onChange={setTos}
              placeholder={rel ? '目标节点' : '目标节点（可多选，一次建立多条）'}
              disabled={!!rel}
            />
            {rel && <span className="text-xs text-muted-foreground">编辑时不可更改端点（如需请删除后重建）</span>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rel-desc">描述</Label>
            <Input id="rel-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>属性</Label>
            {attrRows.length === 0 && !addingField && (
              <span className="text-xs text-muted-foreground">暂无字段，可点击「添加字段」新增</span>
            )}
            {attrRows.map((row) => (
              <div key={row.name} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-2">
                <span className="flex items-center gap-1 truncate text-xs font-medium">
                  {row.name}
                  {row.isNew && <Badge variant="secondary">新</Badge>}
                </span>
                <Input
                  value={row.value}
                  onChange={(e) => setAttrRows((rows) =>
                    rows.map((r) => (r.name === row.name ? { ...r, value: e.target.value } : r)))}
                />
              </div>
            ))}
            {addingField ? (
              <div className="flex gap-2">
                <Input
                  autoFocus
                  value={fieldName}
                  onChange={(e) => setFieldName(e.target.value)}
                  placeholder="字段名（字母/数字/下划线）"
                  onKeyDown={(e) => { if (e.key === 'Enter') confirmAddField(); }}
                />
                <Button variant="outline" size="sm" onClick={confirmAddField}>确定</Button>
                <Button variant="ghost" size="sm" onClick={() => { setAddingField(false); setFieldName(''); }}>取消</Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" className="w-fit" onClick={() => setAddingField(true)}>添加字段</Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Switch id="rel-dep" checked={isDeprecate} onCheckedChange={setIsDeprecate} />
            <Label htmlFor="rel-dep">弃用（is_deprecate，图上降低透明度）</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => void handleSave()} disabled={saving}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

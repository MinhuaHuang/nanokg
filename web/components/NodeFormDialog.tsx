import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import type { NodeRecord } from '../types';

interface AttrRow { name: string; value: string; isNew: boolean }

interface Props {
  open: boolean;
  node: NodeRecord | null;   // null = 新增
  onClose: () => void;
  onSaved: () => void;
}

export default function NodeFormDialog({ open, node, onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [description, setDescription] = useState('');
  const [attrRows, setAttrRows] = useState<AttrRow[]>([]);
  const [addingField, setAddingField] = useState(false);
  const [fieldName, setFieldName] = useState('');
  const [isDeprecate, setIsDeprecate] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(node?.name ?? '');
    setType(node?.type ?? '');
    setDescription(node?.description ?? '');
    setIsDeprecate(node?.is_deprecate ?? false);
    setAddingField(false);
    setFieldName('');
    // 仅渲染该节点已有且非空的 attrs；空值/null 行不显示（需要时「添加字段」）
    const attrs = node?.attrs ?? {};
    setAttrRows(
      Object.entries(attrs)
        .filter(([, v]) => v !== null && v !== '')
        .map(([k, v]) => ({ name: k, value: v ?? '', isNew: false })),
    );
  }, [open, node]);

  function confirmAddField() {
    const n = fieldName.trim();
    if (!/^[A-Za-z0-9_]+$/.test(n)) { toast.error('字段名仅限字母、数字、下划线'); return; }
    if (attrRows.some((r) => r.name === n)) { toast.error(`字段「${n}」已存在`); return; }
    setAttrRows((rows) => [...rows, { name: n, value: '', isNew: true }]);
    setFieldName('');
    setAddingField(false);
  }

  async function handleSave() {
    // 空串值也提交（清空语义：updateNode SET 空串覆盖旧值）；仅过滤未命名字段
    const attrs = Object.fromEntries(attrRows.filter((r) => r.name).map((r) => [r.name, r.value]));
    setSaving(true);
    try {
      // PUT 侧 server 不 trim name，这里统一传 trim 后的值（与 POST 侧行为一致）
      const body = { name: name.trim(), type: type.trim(), description, attrs, is_deprecate: isDeprecate };
      if (node) {
        await api.updateNode(node.id, body);
      } else {
        await api.createNode(body);
      }
      toast.success(node ? '节点已更新' : '节点已创建');
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
        <DialogHeader>
          <DialogTitle>{node ? '编辑节点' : '新增节点'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="name">名称</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="节点名称（唯一）" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="node-type">类型</Label>
            <Input id="node-type" value={type} onChange={(e) => setType(e.target.value)} placeholder="系统 / 接口 / 服务" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="desc">描述</Label>
            <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} />
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
            <Switch id="dep" checked={isDeprecate} onCheckedChange={setIsDeprecate} />
            <Label htmlFor="dep">弃用（is_deprecate，图上灰显）</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

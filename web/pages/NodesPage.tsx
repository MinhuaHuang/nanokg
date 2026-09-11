import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import NodeFormDialog from '../components/NodeFormDialog';
import { NodeTypeIcon } from '../nodeIcon';
import ImportDialog from '../components/ImportDialog';
import TypePicker from '../components/TypePicker';
import { api, ApiError } from '../api';
import { fmtTime } from '../formatTime';
import type { NodeRecord, RelRecord } from '../types';

interface RelWithName extends RelRecord {
  fromName?: string;
  toName?: string;
}

export default function NodesPage() {
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [includeDeprecate, setIncludeDeprecate] = useState(true);
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<NodeRecord | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [preview, setPreview] = useState<NodeRecord | null>(null);
  const [previewRels, setPreviewRels] = useState<RelWithName[]>([]);
  const [deleting, setDeleting] = useState<NodeRecord | null>(null);
  const navigate = useNavigate();
  const seqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const firstRunRef = useRef(true);

  // 全部查询条件并入依赖：任一变化 → refresh 重建 → 下方 effect 防抖重查
  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const list = await api.listNodes({
        name: search || undefined, type: type || undefined, includeDeleted, includeDeprecate,
      });
      if (seq === seqRef.current) setNodes(list);
    } catch (e) {
      if (seq === seqRef.current) toast.error(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [search, type, includeDeleted, includeDeprecate]);

  // 首跑 0 延迟立即首载，后续条件变化防抖 300ms（无独立挂载 effect，避免双请求）
  useEffect(() => {
    const first = firstRunRef.current;
    firstRunRef.current = false;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void refresh(), first ? 0 : 300);
    return () => clearTimeout(debounceRef.current);
  }, [refresh]);

  // 前端分页：数据全量在前端（卡点是数千行 DOM 渲染，非传输），只渲染当前页。
  // 查询条件变化重置第 1 页；当前页超过总页数（删数据后）自动收敛。
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(nodes.length / pageSize));
  const curPage = Math.min(page, totalPages);
  const pageNodes = nodes.slice((curPage - 1) * pageSize, curPage * pageSize);
  useEffect(() => { setPage(1); }, [search, type, includeDeleted, includeDeprecate]);

  async function openPreview(n: NodeRecord) {
    const seq = ++seqRef.current;
    setPreview(n);
    try {
      const rels = await api.listRels({ nodeId: n.id });
      if (seq !== seqRef.current) return;
      const nameMap = new Map(nodes.map((x) => [x.id, x.name]));
      setPreviewRels(rels.map((r) => ({
        ...r,
        fromName: nameMap.get(r.from) ?? r.from,
        toName: nameMap.get(r.to) ?? r.to,
      })));
    } catch {
      if (seq === seqRef.current) setPreviewRels([]);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await api.deleteNode(deleting.id);
      toast.success(`已软删「${deleting.name}」及其关联关系`);
      setDeleting(null);
      void refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '删除失败');
    }
  }

  async function handleRestore(n: NodeRecord) {
    try {
      await api.restoreNode(n.id);
      toast.success(`已还原「${n.name}」`);
      void refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '还原失败');
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6">
      <div className="flex items-center gap-2">
        <Input
          placeholder="按名称搜索…" className="max-w-xs"
          value={search} onChange={(e) => setSearch(e.target.value)}
        />
        <TypePicker value={type} onChange={setType} />
        <div className="flex items-center gap-1.5">
          <Switch id="q-include-deleted" size="sm" checked={includeDeleted} onCheckedChange={setIncludeDeleted} />
          <Label htmlFor="q-include-deleted" className="text-sm">包含删除</Label>
        </div>
        <div className="flex items-center gap-1.5">
          <Switch id="q-include-deprecate" size="sm" checked={includeDeprecate} onCheckedChange={setIncludeDeprecate} />
          <Label htmlFor="q-include-deprecate" className="text-sm">包含弃用</Label>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>导入</Button>
          <Button onClick={() => { setEditing(null); setFormOpen(true); }}>新增节点</Button>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>描述</TableHead>
            <TableHead>弃用</TableHead>
            <TableHead>创建时间</TableHead>
            <TableHead>更新时间</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageNodes.map((n) => (
            <TableRow key={n.id}>
              <TableCell className="font-medium">
                <div className="flex items-center gap-1">
                  {n.deleted_time && <Badge variant="destructive">已删除</Badge>}
                  <NodeTypeIcon type={n.type} className="size-4 shrink-0 text-muted-foreground" />
                  {n.name}
                </div>
              </TableCell>
              <TableCell>{n.type || '—'}</TableCell>
              <TableCell className="max-w-64 truncate">{n.description || '—'}</TableCell>
              <TableCell>
                <div className="flex items-center gap-1 text-sm">
                  <span>{n.is_deprecate ? '是' : '否'}</span>
                  {n.is_deprecate && <Badge variant="secondary">已弃用</Badge>}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {fmtTime(n.created_time)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {fmtTime(n.updated_time)}
              </TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm" onClick={() => void openPreview(n)}>预览</Button>
                <Button variant="ghost" size="sm" onClick={() => navigate(`/graph/${n.id}`)}>关系图</Button>
                {n.deleted_time ? (
                  <Button variant="ghost" size="sm" onClick={() => void handleRestore(n)}>还原</Button>
                ) : (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => { setEditing(n); setFormOpen(true); }}>编辑</Button>
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(n)}>删除</Button>
                  </>
                )}
              </TableCell>
            </TableRow>
          ))}
          {nodes.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground">无数据</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {nodes.length > pageSize && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>共 {nodes.length} 条 · 第 {curPage}/{totalPages} 页</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={curPage <= 1} onClick={() => setPage(1)}>首页</Button>
            <Button variant="outline" size="sm" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>上一页</Button>
            <Button variant="outline" size="sm" disabled={curPage >= totalPages} onClick={() => setPage(curPage + 1)}>下一页</Button>
            <Button variant="outline" size="sm" disabled={curPage >= totalPages} onClick={() => setPage(totalPages)}>末页</Button>
          </div>
        </div>
      )}

      <NodeFormDialog
        open={formOpen} node={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => void refresh()}
      />
      <ImportDialog
        open={importOpen} onClose={() => setImportOpen(false)}
        onImported={() => void refresh()}
      />

      <Sheet open={!!preview} onOpenChange={(v) => !v && setPreview(null)}>
        <SheetContent className="min-w-96 overflow-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <NodeTypeIcon type={preview?.type ?? ''} className="size-4 shrink-0 text-muted-foreground" />
              {preview?.name}
            </SheetTitle>
          </SheetHeader>
          {preview && (
            <div className="grid gap-4 px-4 pb-6 text-sm">
              <div><span className="text-muted-foreground">描述：</span>{preview.description || '—'}</div>
              <div><span className="text-muted-foreground">类型：</span>{preview.type || '—'}</div>
              <div><span className="text-muted-foreground">弃用：</span>{preview.is_deprecate ? '是' : '否'}</div>
              <div>
                <span className="text-muted-foreground">属性：</span>
                {(() => {
                  // null/空串值不渲染
                  const entries = Object.entries(preview.attrs ?? {}).filter(([, v]) => v !== null && v !== '');
                  return entries.length ? (
                    <ul className="mt-1 grid gap-1">
                      {entries.map(([k, v]) => (
                        <li key={k} className="rounded border p-2 text-xs"><span className="font-medium">{k}</span>: {v}</li>
                      ))}
                    </ul>
                  ) : <div className="text-muted-foreground">—</div>;
                })()}
              </div>
              <div><span className="text-muted-foreground">创建时间：</span>{fmtTime(preview.created_time)}</div>
              <div><span className="text-muted-foreground">更新时间：</span>{fmtTime(preview.updated_time)}</div>
              {preview.deleted_time && (
                <div><span className="text-muted-foreground">删除时间：</span>{fmtTime(preview.deleted_time)}</div>
              )}
              <div>
                <span className="text-muted-foreground">关联关系（{previewRels.length}）：</span>
                {previewRels.length === 0 ? (
                  <div className="text-muted-foreground">无</div>
                ) : (
                  <ul className="mt-1 grid gap-1">
                    {previewRels.map((r) => (
                      <li key={r.id} className="rounded border p-2 text-xs">
                        <span className="font-medium">{r.type}</span>
                        {' '}
                        {r.from === preview.id
                          ? `→ ${r.toName ?? r.to}`
                          : `← ${r.fromName ?? r.from}`}
                        {r.is_deprecate && <Badge variant="secondary" className="ml-1">已弃用</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除节点「{deleting?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              将执行软删除（deleted_time 标记），其关联关系一并软删，默认视图中不再显示。导出时可用「包含已删除」取回。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

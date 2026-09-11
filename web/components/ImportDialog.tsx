import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import GraphView from './GraphView';
import type { ExportData, NodeRecord, RelRecord } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

/** ExportData → GraphView 预览记录。节点 id 用序号（软删同名共存须唯一）；
 *  rel 端点按 name 解析（未删条目优先、软删条目兜底，与后端导入同语义），
 *  悬空引用（解析不到端点）丢弃并计数。预览不需要的字段填空值。 */
function toPreview(data: ExportData): { nodes: NodeRecord[]; edges: RelRecord[]; dangling: number } {
  const nodes: NodeRecord[] = data.nodes.map((n, i) => ({
    id: `n${i}`,
    name: String(n.name ?? ''),
    type: typeof n.type === 'string' ? n.type : '',
    description: '', attrs: {}, created_time: '', updated_time: '',
    deleted_time: n.deleted_time ?? null,
    is_deprecate: n.is_deprecate ?? false,
  }));
  const nameToId = new Map<string, string>();
  data.nodes.forEach((n, i) => { if (!n.deleted_time) nameToId.set(String(n.name), `n${i}`); });
  data.nodes.forEach((n, i) => {
    if (n.deleted_time && !nameToId.has(String(n.name))) nameToId.set(String(n.name), `n${i}`);
  });
  let dangling = 0;
  const edges: RelRecord[] = [];
  data.rels.forEach((r, i) => {
    const from = nameToId.get(String(r.from));
    const to = nameToId.get(String(r.to));
    if (!from || !to) { dangling++; return; }
    edges.push({
      id: `r${i}`, type: String(r.type), from, to,
      description: '', attrs: {}, created_time: '', updated_time: '',
      deleted_time: r.deleted_time ?? null,
      is_deprecate: r.is_deprecate ?? false,
    });
  });
  return { nodes, edges, dangling };
}

export default function ImportDialog({ open, onClose, onImported }: Props) {
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [data, setData] = useState<unknown>(null);
  const [fileName, setFileName] = useState('');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const preview = useMemo(
    () => (data ? toPreview(data as ExportData) : null),
    [data],
  );

  async function handleFile(file: File) {
    const reset = () => { setData(null); setFileName(''); };
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!parsed || typeof parsed !== 'object'
        || !Array.isArray((parsed as { nodes?: unknown }).nodes)
        || !Array.isArray((parsed as { rels?: unknown }).rels)) {
        reset();
        toast.error('文件格式错误：需 { nodes: [], rels: [] }');
        return;
      }
      setData(parsed);
      setFileName(file.name);
    } catch {
      reset();
      toast.error('文件不是合法 JSON');
    }
  }

  async function doImport() {
    if (!data) return;
    setBusy(true);
    try {
      const counts = await api.importJson(data, mode);
      toast.success(`导入完成：${counts.nodes} 节点 / ${counts.rels} 关系`);
      onImported();
      close();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }

  /** 关闭并清空选择（含预览）——重开时不残留上次的文件与图 */
  function close() {
    onClose();
    setPreviewOpen(false);
    setData(null);
    setFileName('');
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && close()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>导入 JSON</DialogTitle>
            <DialogDescription>选择 NanoKG 导出格式的 JSON 文件</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>文件</Label>
              <input
                type="file" accept=".json" className="text-sm"
                onChange={(e) => { if (e.target.files?.[0]) void handleFile(e.target.files[0]); }}
              />
              {fileName && <span className="text-xs text-muted-foreground">已选择：{fileName}</span>}
            </div>
            <div className="grid gap-2">
              <Label>模式</Label>
              <RadioGroup value={mode} onValueChange={(v) => setMode(v as 'merge' | 'replace')}>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="merge" id="m-merge" />
                  <Label htmlFor="m-merge">合并（仅新增库中不存在的数据；文件中删除条目生效为软删）</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="replace" id="m-replace" />
                  <Label htmlFor="m-replace">替换（清空后导入）</Label>
                </div>
              </RadioGroup>
            </div>
          </div>
          {preview && (
            <div className="grid gap-1.5">
              <span className="text-xs text-muted-foreground">
                {preview.nodes.length} 节点 / {preview.edges.length} 关系
                {preview.dangling > 0 && `（${preview.dangling} 条关系引用文件中不存在的节点，图中未显示）`}
              </span>
              <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
                预览大图
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={close}>取消</Button>
            <Button
              disabled={!data || busy}
              onClick={() => (mode === 'replace' ? setConfirmReplace(true) : void doImport())}
            >
              导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {preview && (
        <Sheet open={previewOpen} onOpenChange={setPreviewOpen}>
          <SheetContent
            side="bottom"
            className="h-svh w-full max-w-none gap-2 rounded-t-xl p-4"
          >
            <SheetHeader className="flex-row flex-wrap items-center gap-3 pr-12">
              <SheetTitle className="text-base">{fileName || '导入预览'}</SheetTitle>
              <SheetDescription>
                {preview.nodes.length} 节点 / {preview.edges.length} 关系
                {preview.dangling > 0 && `（${preview.dangling} 条关系引用文件中不存在的节点，图中未显示）`}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1">
              <GraphView nodes={preview.nodes} edges={preview.edges} />
            </div>
          </SheetContent>
        </Sheet>
      )}
      <AlertDialog open={confirmReplace} onOpenChange={setConfirmReplace}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认替换全部数据？</AlertDialogTitle>
            <AlertDialogDescription>
              替换模式将先清空当前所有节点与关系，再导入文件内容。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doImport()}>确认替换</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

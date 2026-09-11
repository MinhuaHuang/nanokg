import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

interface Props {
  includeDeprecate: boolean;
  includeDeleted: boolean;
  onChange: (patch: { includeDeprecate?: boolean; includeDeleted?: boolean }) => void;
}

/** 图视图查询条件开关组：包含弃用（默认是）/ 包含删除（默认否），与节点管理页同款形态 */
export default function FilterSwitches({ includeDeprecate, includeDeleted, onChange }: Props) {
  return (
    <>
      <div className="flex items-center gap-1.5">
        <Switch
          id="graph-include-deleted" size="sm" checked={includeDeleted}
          onCheckedChange={(v) => onChange({ includeDeleted: v })}
        />
        <Label htmlFor="graph-include-deleted" className="text-sm">包含删除</Label>
      </div>
      <div className="flex items-center gap-1.5">
        <Switch
          id="graph-include-deprecate" size="sm" checked={includeDeprecate}
          onCheckedChange={(v) => onChange({ includeDeprecate: v })}
        />
        <Label htmlFor="graph-include-deprecate" className="text-sm">包含弃用</Label>
      </div>
    </>
  );
}

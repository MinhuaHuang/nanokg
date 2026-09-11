import { useEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { XIcon } from 'lucide-react';
import { api } from '../api';
import type { NodeRecord } from '../types';

interface Props {
  values: NodeRecord[];
  onChange: (ns: NodeRecord[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

/** 远程搜索多选节点的 Combobox：选项点击 toggle（面板保持打开，便于连选），
 *  已选以 chip 展示、点 × 移除。搜索/防抖/竞态守卫与 NodePicker 同款。 */
export default function NodeMultiPicker({ values, onChange, placeholder, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<NodeRecord[]>([]);
  const seqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  async function search(q: string) {
    const seq = ++seqRef.current;
    try {
      const list = await api.listNodes(q ? { name: q } : {});
      if (seq === seqRef.current) setOptions(list);
    } catch {
      if (seq === seqRef.current) setOptions([]);
    }
  }

  function searchDebounced(q: string) {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void search(q), 200);
  }

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const remove = (id: string) => onChange(values.filter((v) => v.id !== id));
  const toggle = (n: NodeRecord) => {
    onChange(values.some((v) => v.id === n.id)
      ? values.filter((v) => v.id !== n.id)
      : [...values, n]);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) {
          clearTimeout(debounceRef.current); // 丢弃挂起的防抖，避免打开后被旧查询覆盖
          void search('');
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline" disabled={disabled}
          className="min-h-9 h-auto w-full justify-start overflow-hidden px-3 py-1.5 font-normal"
        >
          {values.length === 0
            ? (placeholder ?? '选择节点…')
            : (
              <span className="flex min-w-0 flex-1 flex-wrap gap-1 text-left">
                {values.map((n) => (
                  <Badge key={n.id} variant="secondary" className="min-w-0 max-w-full gap-0.5 pr-1">
                    <span className="truncate">{n.name}</span>
                    {!disabled && (
                      <span
                        role="button" tabIndex={0} aria-label={`移除 ${n.name}`}
                        className="rounded p-0.5 hover:bg-muted-foreground/20"
                        onClick={(e) => { e.stopPropagation(); remove(n.id); }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault(); e.stopPropagation(); remove(n.id);
                          }
                        }}
                      >
                        <XIcon className="size-3" />
                      </span>
                    )}
                  </Badge>
                ))}
              </span>
            )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="输入名称搜索…" onValueChange={searchDebounced} />
          <CommandList>
            <CommandEmpty>无匹配</CommandEmpty>
            <CommandGroup>
              {options.map((n) => {
                const sel = values.some((v) => v.id === n.id);
                return (
                  <CommandItem key={n.id} value={n.id} onSelect={() => toggle(n)}>
                    <span className={sel ? 'font-medium' : undefined}>
                      {n.name}{n.is_deprecate ? '（已弃用）' : ''}
                    </span>
                    {sel && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { api } from '../api';
import type { NodeRecord } from '../types';

interface Props {
  value: NodeRecord | null;
  onChange: (n: NodeRecord) => void;
  placeholder?: string;
  disabled?: boolean;
}

/** 远程搜索选节点的 Combobox：shouldFilter=false，过滤交给服务端 name LIKE；防抖 200ms + 竞态守卫 */
export default function NodePicker({ value, onChange, placeholder, disabled }: Props) {
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
        <Button variant="outline" disabled={disabled} className="w-full justify-start overflow-hidden font-normal">
          <span className="min-w-0 flex-1 truncate text-left">{value?.name ?? placeholder ?? '选择节点…'}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="输入名称搜索…" onValueChange={searchDebounced} />
          <CommandList>
            <CommandEmpty>无匹配</CommandEmpty>
            <CommandGroup>
              {options.map((n) => (
                <CommandItem key={n.id} value={n.id} onSelect={() => { onChange(n); setOpen(false); }}>
                  {n.name}{n.is_deprecate ? '（已弃用）' : ''}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

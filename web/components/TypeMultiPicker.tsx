import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { typeColor, UNCATEGORIZED } from '../graphColors';

interface Props {
  selected: Set<string>;                       // 空集 = 不过滤（全部）
  options: { key: string; label: string }[];   // key = 类型名或 UNCATEGORIZED
  onChange: (s: Set<string>) => void;
}

/** 类型多选筛选：Popover + Command 列表，点击项 toggle（●/○ 勾选形态），「全部」清空选择 */
export default function TypeMultiPicker({ selected, options, onChange }: Props) {
  const [open, setOpen] = useState(false);

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="font-normal">
          {selected.size > 0 ? `类型筛选(${selected.size})` : '类型筛选'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandList>
            <CommandEmpty>无类型</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__all__" onSelect={() => onChange(new Set())}>
                全部（不过滤）
              </CommandItem>
              {options.map((o) => (
                <CommandItem key={o.key} value={o.key} onSelect={() => toggle(o.key)}>
                  <span className="w-4 shrink-0 text-center text-xs text-muted-foreground">
                    {selected.has(o.key) ? '●' : '○'}
                  </span>
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: typeColor(o.key === UNCATEGORIZED ? '' : o.key) }}
                  />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

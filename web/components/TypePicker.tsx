import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { api } from '../api';

interface Props {
  value: string;                       // 空串 = 不过滤
  onChange: (v: string) => void;
}

/** 类型选择：下拉选已有类型 + 输入自定义值；本地过滤；可清空 */
export default function TypePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [types, setTypes] = useState<string[]>([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    if (open) api.getTypes().then(setTypes).catch(() => setTypes([]));
  }, [open]);

  function pick(v: string) {
    onChange(v.trim());
    setOpen(false);
  }

  const filtered = types.filter((t) => t.toLowerCase().includes(input.toLowerCase()));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-40 justify-start font-normal">
          {value || '类型（全部）'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="输入类型过滤或自定义…" value={input} onValueChange={setInput} />
          <CommandList>
            <CommandEmpty>{input.trim() ? '无匹配 — 回车使用自定义值' : '无类型'}</CommandEmpty>
            {input.trim() && !filtered.some((t) => t === input.trim()) && (
              <CommandGroup>
                <CommandItem value={`__custom__${input}`} onSelect={() => pick(input)}>
                  使用「{input.trim()}」
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup>
              {value && (
                <CommandItem value="__clear__" onSelect={() => pick('')}>✕ 清除（全部类型）</CommandItem>
              )}
              {filtered.map((t) => (
                <CommandItem key={t} value={t} onSelect={() => pick(t)}>{t}</CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

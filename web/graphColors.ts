/** 分类调色板（Tailwind 600 系，避开弃用灰 #94a3b8 与删除淡灰 #cbd5e1） */
export const TYPE_PALETTE = [
  '#2563eb', // blue
  '#ea580c', // orange
  '#16a34a', // green
  '#dc2626', // red
  '#7c3aed', // violet
  '#0d9488', // teal
  '#db2777', // pink
  '#65a30d', // lime
  '#ca8a04', // amber
  '#0891b2', // cyan
];

/** type → 确定性颜色（字符串 hash 取模，空 type 用默认蓝） */
export function typeColor(type: string): string {
  if (!type) return TYPE_PALETTE[0];
  let h = 0;
  for (const ch of type) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return TYPE_PALETTE[h % TYPE_PALETTE.length];
}

export const UNCATEGORIZED = '__uncategorized__'; // 图数据中空 type 的伪类型键

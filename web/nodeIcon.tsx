import { renderToStaticMarkup } from 'react-dom/server';
import { CalendarClock, CircleQuestionMark, Code, Columns4, Database, Link2, Layers, LayersArrowDown, LayersArrowUp, FolderInput, FolderOutput, Hexagon, Webhook } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** 节点类型 → Lucide 图标（key 为大写规范型） */
const TYPE_ICONS: Record<string, LucideIcon> = {
  MQ: Columns4,
  TABLE: Database,
  REST: Webhook,
  XXLJOB: CalendarClock,
  CODE: Code,
  BIZ_MOUDLE: Layers,
  ENTITY: Hexagon,
  IMPORT_TASK: FolderInput,
  EXPORT_TASK: FolderOutput,
  MQ_CONSUMER: LayersArrowDown,
  MQ_PRODUCER: LayersArrowUp,
  FEIGN: Link2,
};

/** 类型 → 图标（大小写不敏感；未匹配回退 CircleQuestionMark） */
export function nodeIconOf(type: string): LucideIcon {
  return TYPE_ICONS[type.trim().toUpperCase()] ?? CircleQuestionMark;
}

/** 列表/预览/图例等 React 层展示 */
export function NodeTypeIcon({ type, className }: { type: string; className?: string }) {
  const Icon = nodeIconOf(type);
  return <Icon className={className} aria-hidden />;
}

/** 图上节点用：类型 → 白色线条、透明底 icon 的 SVG dataURL（图标种类有限，模块级缓存）。
 *  节点底色仍由 sigma 节点 color 提供（image program 的 background 模式按 alpha 叠加）。 */
const dataUrlCache = new Map<string, string>();
export function nodeIconDataUrl(type: string): string {
  const key = type.trim().toUpperCase();
  let url = dataUrlCache.get(key);
  if (!url) {
    const Icon = nodeIconOf(type);
    const svg = renderToStaticMarkup(<Icon color="#fff" size={24} />);
    url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    dataUrlCache.set(key, url);
  }
  return url;
}

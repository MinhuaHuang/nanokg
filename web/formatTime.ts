/** ISO 时间 → `yyyy-MM-dd hh:mm:ss`（本地时区） */
export function fmtTime(iso: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const d = new Date(iso);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

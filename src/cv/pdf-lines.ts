import type { TextItem } from "./pdf-inspect.js";

export interface TextLine {
  page: number;
  /** Baseline from the top of the page, in pt. */
  y: number;
  /** Left edge of the first run. */
  x: number;
  /** Right edge of the last run. */
  right: number;
  text: string;
}

/** Groups text runs that share a page and baseline into lines, in reading order. */
export function toLines(items: (TextItem & { width?: number })[]): TextLine[] {
  const lines: TextLine[] = [];
  const sorted = [...items].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  for (const it of sorted) {
    const last = lines.at(-1);
    const right = it.x + (it.width ?? 0);
    if (last && last.page === it.page && Math.abs(last.y - it.y) < 1.5) {
      last.text += (it.x - last.right > 1 ? " " : "") + it.text;
      last.right = Math.max(last.right, right);
    } else {
      lines.push({ page: it.page, y: it.y, x: it.x, right, text: it.text });
    }
  }
  return lines;
}

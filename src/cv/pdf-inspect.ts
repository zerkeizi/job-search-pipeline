import { readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface TextItem {
  page: number;
  text: string;
  x: number;
  /** Baseline, measured from the top of the page, in pt. */
  y: number;
  size: number;
  width: number;
}

export interface PdfLayout {
  pages: number;
  items: TextItem[];
}

export async function inspectPdf(path: string): Promise<PdfLayout> {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
  const items: TextItem[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const [a, , , , x, y] = item.transform as number[];
      items.push({ page: n, text: item.str, x: x ?? 0, y: height - (y ?? 0), size: a ?? 0, width: item.width });
    }
  }
  return { pages: doc.numPages, items };
}

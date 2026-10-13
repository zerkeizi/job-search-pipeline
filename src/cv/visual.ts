import { pdf } from "pdf-to-img";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface PageDiff {
  page: number;
  diffRatio: number;
}

async function rasterize(path: string): Promise<PNG[]> {
  const pages: PNG[] = [];
  for await (const image of await pdf(path, { scale: 2 })) pages.push(PNG.sync.read(image));
  return pages;
}

/** Rasterizes both PDFs and returns, per page, the share of pixels that differ. */
export async function comparePdfPixels(expectedPath: string, actualPath: string): Promise<PageDiff[]> {
  const [expected, actual] = await Promise.all([rasterize(expectedPath), rasterize(actualPath)]);
  return expected.map((a, i) => {
    const b = actual[i];
    if (!b || a.width !== b.width || a.height !== b.height) return { page: i + 1, diffRatio: 1 };
    const diff = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 });
    return { page: i + 1, diffRatio: diff / (a.width * a.height) };
  });
}

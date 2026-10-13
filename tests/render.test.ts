import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { inspectPdf, type PdfLayout } from "../src/cv/pdf-inspect.js";
import { toLines } from "../src/cv/pdf-lines.js";
import { loadBaseCv } from "../src/cv/schema.js";
import { comparePdfPixels } from "../src/cv/visual.js";
import { fitCvToOnePage, renderCvPdf } from "../src/render.js";

// Rendering the unchanged Base CV must reproduce cv/original.pdf.
describe("render regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "jobpipe-render-"));
  const out = join(dir, "cv.pdf");
  let original: PdfLayout;
  let rendered: PdfLayout;

  beforeAll(async () => {
    await renderCvPdf(loadBaseCv(), loadConfig().render, out);
    [original, rendered] = await Promise.all([inspectPdf("cv/original.pdf"), inspectPdf(out)]);
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("has the same number of pages", () => {
    expect(rendered.pages).toBe(original.pages);
  });

  it("puts every line of text where the original does (within 0.5pt)", () => {
    const [a, b] = [toLines(original.items), toLines(rendered.items)];
    expect(b.map((l) => l.text.replace(/\s+/g, ""))).toEqual(a.map((l) => l.text.replace(/\s+/g, "")));
    a.forEach((line, i) => {
      const mine = b[i]!;
      expect(mine.page, line.text).toBe(line.page);
      expect(Math.abs(mine.y - line.y), line.text).toBeLessThan(0.5);
      expect(Math.abs(mine.x - line.x), line.text).toBeLessThan(0.5);
    });
  });

  it("matches the original pixel by pixel within 2%", async () => {
    for (const { page, diffRatio } of await comparePdfPixels("cv/original.pdf", out)) {
      expect(diffRatio, `page ${page}`).toBeLessThan(0.02);
    }
  }, 60_000);
});

describe("fit to one page", () => {
  it("scales down step by step and never below min_scale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobpipe-fit-"));
    try {
      const render = loadConfig().render;
      const out = join(dir, "cv.pdf");
      const { scale, pages } = await fitCvToOnePage(loadBaseCv(), render, out);
      expect((await inspectPdf(out)).pages).toBe(pages);
      expect(scale).toBeGreaterThanOrEqual(render.min_scale);
      expect(scale).toBeLessThanOrEqual(1);
      // The unchanged Base CV is 2 pages at scale 1, so fitting must have scaled it down.
      expect(scale).toBeLessThan(1);
      if (pages > 1) expect(scale).toBe(render.min_scale);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

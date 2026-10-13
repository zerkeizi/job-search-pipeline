import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Handlebars from "handlebars";
import { PDFDocument } from "pdf-lib";
import { type Browser, chromium } from "playwright";
import type { Config } from "./config.js";
import type { BaseCv } from "./cv/schema.js";

const TEMPLATE_DIR = "cv/template";

/** Page geometry of cv/original.pdf (Google Docs export): 596pt x 842pt page, 21.26pt top/bottom margin. */
const PAGE = { widthPt: 596, heightPt: 842, marginY: 21.26 };
const ptToIn = (pt: number) => `${(pt / 72).toFixed(5)}in`;

/**
 * Chromium rounds line heights to whole CSS pixels (15.87pt = 21.16px becomes 21px), which drifts
 * ~0.12pt per line. Laying out at SUPERSAMPLE x zoom and printing at 1/SUPERSAMPLE scale makes the
 * rounding error negligible (127px for 126.96px).
 */
const SUPERSAMPLE = 6;

function fontFaces(render: Config["render"]): string {
  const face = (file: string, weight: string) =>
    `@font-face { font-family: "CV Serif"; font-weight: ${weight}; src: url("${pathToFileURL(join(render.font_dir, file)).href}"); }`;
  return [face(render.fonts.regular, "normal"), face(render.fonts.bold, "bold")].join("\n");
}

export function renderCvHtml(cv: BaseCv, render: Config["render"]): string {
  const template = Handlebars.compile(readFileSync(join(TEMPLATE_DIR, "cv.hbs"), "utf8"), { strict: true });
  const css = readFileSync(join(TEMPLATE_DIR, "cv.css"), "utf8");
  return template({ cv, css, fontFaces: fontFaces(render) });
}

export interface FitResult {
  scale: number;
  pages: number;
}

/**
 * Renders the CV to a PDF at the given scale (1 = the original's sizes). The scale shrinks fonts,
 * spacing and margins proportionally. The HTML is written next to the PDF and loaded via file://
 * so local fonts resolve. Returns the page count.
 */
export async function renderCvPdf(cv: BaseCv, render: Config["render"], pdfPath: string, scale = 1): Promise<number> {
  const browser = await chromium.launch();
  try {
    return await renderWith(browser, cv, render, pdfPath, scale);
  } finally {
    await browser.close();
  }
}

/**
 * Renders the CV on a single page: tries scale 1, then steps down by render.scale_step until it fits
 * or reaches render.min_scale. A result with pages > 1 means it didn't fit even at min_scale.
 */
export async function fitCvToOnePage(cv: BaseCv, render: Config["render"], pdfPath: string): Promise<FitResult> {
  const browser = await chromium.launch();
  try {
    let scale = 1;
    for (;;) {
      const pages = await renderWith(browser, cv, render, pdfPath, scale);
      const next = Math.round((scale - render.scale_step) * 1000) / 1000;
      if (pages === 1 || next < render.min_scale) return { scale, pages };
      scale = next;
    }
  } finally {
    await browser.close();
  }
}

async function renderWith(
  browser: Browser,
  cv: BaseCv,
  render: Config["render"],
  pdfPath: string,
  scale: number,
): Promise<number> {
  const out = resolve(pdfPath);
  mkdirSync(dirname(out), { recursive: true });
  const htmlPath = out.replace(/\.pdf$/i, "") + ".html";
  writeFileSync(htmlPath, renderCvHtml(cv, render));

  const page = await browser.newPage();
  try {
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    // With `scale`, Chromium multiplies @page margins by SUPERSAMPLE, so they are given pre-divided.
    // (The `margin` option of page.pdf() is not linear under scale, so it is left at zero.)
    await page.addStyleTag({
      content: [
        `html { zoom: ${SUPERSAMPLE * scale}; --page-width: ${PAGE.widthPt / scale}pt; }`,
        `@page { margin: ${(PAGE.marginY * scale) / SUPERSAMPLE}pt 0; }`,
      ].join("\n"),
    });
    await page.pdf({
      path: out,
      width: ptToIn(PAGE.widthPt),
      height: ptToIn(PAGE.heightPt),
      scale: 1 / SUPERSAMPLE,
      printBackground: true,
    });
  } finally {
    await page.close();
  }
  return setExactPageSize(out);
}

/** Chromium quantizes the paper size (596pt comes out as 597.12pt); trim the extra blank edge. Returns the page count. */
async function setExactPageSize(pdfPath: string): Promise<number> {
  const doc = await PDFDocument.load(readFileSync(pdfPath));
  for (const page of doc.getPages()) {
    page.setMediaBox(0, page.getHeight() - PAGE.heightPt, PAGE.widthPt, PAGE.heightPt);
  }
  writeFileSync(pdfPath, await doc.save());
  return doc.getPageCount();
}

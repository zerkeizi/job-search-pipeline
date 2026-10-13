// Dev tool: renders cv/base.yaml and prints, line by line, how far the rendered PDF is from
// cv/original.pdf (baseline dy, left edge dx, right edge dr; all in pt). Used to tune cv/template/cv.css.
// Prints only lines off by more than 0.3pt (or whose text differs) unless --verbose is given.
import { loadConfig } from "../src/config.js";
import { inspectPdf } from "../src/cv/pdf-inspect.js";
import { toLines } from "../src/cv/pdf-lines.js";
import { loadBaseCv } from "../src/cv/schema.js";
import { renderCvPdf } from "../src/render.js";

const verbose = process.argv.includes("--verbose");
const out = process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? "output/_layout/cv.pdf";
await renderCvPdf(loadBaseCv(), loadConfig().render, out);
const [orig, mine] = await Promise.all([inspectPdf("cv/original.pdf"), inspectPdf(out)]);
const [a, b] = [toLines(orig.items), toLines(mine.items)];
console.log(`pages: original=${orig.pages} rendered=${mine.pages}; lines: original=${a.length} rendered=${b.length}`);
let worst = 0;
a.forEach((o, i) => {
  const m = b[i];
  if (!m) return console.log(`  MISSING ${o.text.slice(0, 40)}`);
  const dy = m.y - o.y + (m.page - o.page) * 1000;
  const dx = m.x - o.x;
  const dr = m.right - o.right;
  worst = Math.max(worst, Math.abs(dy), Math.abs(dx));
  const flag = [dy, dx].some((d) => Math.abs(d) > 0.3) ? "!" : " ";
  const same = m.text.replace(/\s+/g, "") === o.text.replace(/\s+/g, "") ? "" : `  ≠ "${m.text.slice(0, 30)}"`;
  if (verbose || flag === "!" || same) console.log(`${flag} p${o.page} y=${o.y.toFixed(2).padStart(6)} dy=${dy.toFixed(2).padStart(6)} dx=${dx.toFixed(2).padStart(6)} dr=${dr.toFixed(2).padStart(6)}  ${o.text.slice(0, 40)}${same}`);
});
console.log(`worst |dy|,|dx|: ${worst.toFixed(2)}pt`);

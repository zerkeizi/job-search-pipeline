import { readFileSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";
import { generate } from "./generate.js";
import type { ClaudeRunner } from "./llm.js";
import {
  collectorStatus,
  discardJob,
  jobDetail,
  keepSeparate,
  listAnalysis,
  listApplied,
  listGenerated,
  listQueue,
  markApplied,
  mergeJob,
  pdfPathOf,
  ReviewError,
  type ReviewDeps,
  saveEdits,
  setLocalOffice,
  undoApplied,
} from "./review.js";
import { UsageLog } from "./usage.js";

export interface ServerDeps extends ReviewDeps {
  runner?: ClaudeRunner;
  /** Built panel (web/dist); omitted in tests. */
  webDir?: string;
  /** Where the usage log goes (default data/logs). */
  logDir?: string;
}

const editsSchema = z.object({ summary: z.string(), bullets: z.array(z.array(z.string())), coverLetter: z.string() });

/**
 * API for the review panel. Listens on localhost only. Every state change needs the
 * `x-jobpipe` header: a page on another site can't send it without a CORS preflight, which
 * this server never allows, so no other site can drive the panel from my browser.
 */
export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();
  let regenerating = false;

  app.onError((err, c) => {
    if (err instanceof ReviewError) return c.json({ error: err.message, details: err.details }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", details: err.issues.map((i) => i.message) }, 400);
    console.error(err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.header("x-jobpipe") !== "1") return c.json({ error: "missing x-jobpipe header" }, 403);
    await next();
  });

  app.get("/api/jobs", (c) => c.json(c.req.query("view") === "applied" ? listApplied(deps) : listGenerated(deps)));
  app.get("/api/jobs/:id", (c) => c.json(jobDetail(deps, c.req.param("id"))));
  app.get("/api/jobs/:id/cv.pdf", (c) => {
    const path = pdfPathOf(deps.outputDir, c.req.param("id"));
    if (!path) return c.json({ error: "no PDF" }, 404);
    return c.body(readFileSync(path), 200, { "content-type": "application/pdf", "cache-control": "no-store" });
  });

  app.put("/api/jobs/:id/edits", async (c) => c.json(await saveEdits(deps, c.req.param("id"), editsSchema.parse(await c.req.json()))));

  app.post("/api/jobs/:id/regenerate", async (c) => {
    if (regenerating) return c.json({ error: "another regeneration is running" }, 409);
    regenerating = true;
    try {
      const usage = new UsageLog("regenerate", deps.logDir);
      const [outcome] = await generate([c.req.param("id")], { ...deps, usage });
      console.log(usage.finish());
      return c.json(outcome);
    } finally {
      regenerating = false;
    }
  });

  app.post("/api/jobs/:id/discard", async (c) => {
    const { reason } = z.object({ reason: z.string().nullable().optional() }).parse(await c.req.json());
    discardJob(deps.db, c.req.param("id"), reason ?? null);
    return c.json({ ok: true });
  });
  app.post("/api/jobs/:id/applied", (c) => {
    markApplied(deps.db, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/jobs/:id/undo-applied", (c) => {
    undoApplied(deps.db, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.put("/api/jobs/:id/local-office", async (c) => {
    const { value } = z.object({ value: z.boolean().nullable() }).parse(await c.req.json());
    setLocalOffice(deps, c.req.param("id"), value);
    return c.json({ ok: true });
  });

  app.get("/api/queue", (c) => c.json(listQueue(deps)));
  app.get("/api/analysis", (c) => c.json(listAnalysis(deps)));
  app.post("/api/analysis/:id/merge", (c) => c.json({ mergedInto: mergeJob(deps, c.req.param("id")) }));
  app.post("/api/analysis/:id/keep", (c) => {
    keepSeparate(deps.db, c.req.param("id"));
    return c.json({ ok: true, queued: true });
  });

  app.get("/api/collectors", (c) => c.json(collectorStatus(deps)));

  if (deps.webDir) {
    app.use("/*", serveStatic({ root: deps.webDir }));
    app.get("*", serveStatic({ path: `${deps.webDir}/index.html` }));
  }
  return app;
}

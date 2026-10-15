import { readFileSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";
import {
  CompanyError,
  mergeCompanies,
  refreshLocalOffice,
  renameCompany,
  setCompanyLocalOffice,
  setFollowed,
  syncCompanies,
} from "./companies.js";
import { addManualJob } from "./collectors/manual.js";
import { generate } from "./generate.js";
import type { ClaudeRunner } from "./llm.js";
import {
  collectorStatus,
  discardJob,
  jobDetail,
  keepSeparate,
  listAnalysis,
  listCompanies,
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
import { runScoring } from "./scoring.js";
import { WORKPLACES } from "./status.js";
import { GENERATE_MODES } from "./tailoring.js";
import { UsageLog } from "./usage.js";

export interface ServerDeps extends ReviewDeps {
  runner?: ClaudeRunner;
  /** Built panel (web/dist); omitted in tests. */
  webDir?: string;
  /** Where the usage log goes (default data/logs). */
  logDir?: string;
}

const editsSchema = z.object({
  summary: z.string().optional(),
  bullets: z.array(z.array(z.string())).optional(),
  coverLetter: z.string().optional(),
});
const manualSchema = z.object({
  description: z.string().trim().min(1, "the job description is empty"),
  url: z.string().nullish(),
  company: z.string().nullish(),
  title: z.string().nullish(),
  location: z.string().nullish(),
  workplace: z.enum(WORKPLACES).optional(),
  officeDays: z.number().int().min(0).max(5).nullish(),
});
const modeSchema = z.object({ mode: z.enum(GENERATE_MODES).default("both") });

/**
 * API for the review panel. Listens on localhost only. Every state change needs the
 * `x-jobpipe` header: a page on another site can't send it without a CORS preflight, which
 * this server never allows, so no other site can drive the panel from my browser.
 */
export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();
  // Jobs collected before Companies existed (or named by a tailoring since) get theirs now.
  syncCompanies(deps.db);
  refreshLocalOffice(deps.db, deps.config.preferences);
  let regenerating = false;

  app.onError((err, c) => {
    if (err instanceof ReviewError) return c.json({ error: err.message, details: err.details }, err.status);
    if (err instanceof CompanyError) return c.json({ error: err.message, details: [] }, 409);
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

  app.post("/api/jobs/:id/generate", async (c) => {
    if (regenerating) return c.json({ error: "another regeneration is running" }, 409);
    regenerating = true;
    try {
      const { mode } = modeSchema.parse(await c.req.json().catch(() => ({})));
      const usage = new UsageLog("regenerate", deps.logDir);
      const [outcome] = await generate([c.req.param("id")], { ...deps, usage }, mode);
      console.log(usage.finish());
      return c.json(outcome);
    } finally {
      regenerating = false;
    }
  });

  // "Add job" in the panel: no LLM call; scoring runs for matches and Gaps, and the Job lands in the Queue.
  app.post("/api/jobs/manual", async (c) => {
    const input = manualSchema.parse(await c.req.json());
    const result = addManualJob(deps.db, input);
    runScoring(deps, { jobIds: [result.jobId] });
    return c.json(result);
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

  app.get("/api/companies", (c) => c.json(listCompanies(deps)));
  app.post("/api/companies/:id/follow", async (c) => {
    const { followed } = z.object({ followed: z.boolean() }).parse(await c.req.json());
    setFollowed(deps.db, c.req.param("id"), followed);
    return c.json({ ok: true });
  });
  app.post("/api/companies/:id/rename", async (c) => {
    const { name } = z.object({ name: z.string() }).parse(await c.req.json());
    renameCompany(deps.db, c.req.param("id"), name);
    return c.json({ ok: true });
  });
  app.post("/api/companies/:id/merge", async (c) => {
    const { into } = z.object({ into: z.string() }).parse(await c.req.json());
    mergeCompanies(deps.db, c.req.param("id"), into, deps.config.preferences);
    return c.json({ ok: true });
  });
  app.put("/api/companies/:id/local-office", async (c) => {
    const { value } = z.object({ value: z.boolean().nullable() }).parse(await c.req.json());
    setCompanyLocalOffice(deps.db, c.req.param("id"), value, deps.config.preferences);
    return c.json({ ok: true });
  });
  app.all("/api/*", (c) => c.json({ error: `unknown API route ${c.req.method} ${c.req.path} — restart \`pnpm jobpipe review\`?` }, 404));

  if (deps.webDir) {
    app.use("/*", serveStatic({ root: deps.webDir }));
    app.get("*", serveStatic({ path: `${deps.webDir}/index.html` }));
  }
  return app;
}

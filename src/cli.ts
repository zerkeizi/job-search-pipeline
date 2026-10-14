import { Command } from "commander";
import { API_SOURCES, collectApiSources } from "./collectors/api.js";
import { collectJobspy, JOBSPY_SITES } from "./collectors/jobspy.js";
import { addManualJobFromFile } from "./collectors/manual.js";
import { loadConfig } from "./config.js";
import { loadBaseCv } from "./cv/schema.js";
import { openDb } from "./db/index.js";
import { formatResults, runDoctor } from "./doctor.js";
import { generate, type GenerateOutcome, pendingJobIds } from "./generate.js";
import { checkBoards, importBoards, syncCompanies } from "./companies.js";
import { runScoring } from "./scoring.js";
import { computeStats, formatStats } from "./stats.js";
import type { GenerateMode } from "./tailoring.js";
import { TechMatcher } from "./tech.js";
import { UsageLog } from "./usage.js";

const program = new Command().name("jobpipe").description("Collect, score and tailor job applications");

program
  .command("doctor")
  .description("check node, pnpm, uv, sidecar, playwright, Claude login, config, fonts and CV files")
  .action(() => {
    const results = runDoctor();
    console.log(formatResults(results));
    if (results.some((r) => r.status === "fail")) process.exitCode = 1;
  });

function printOutcome(o: GenerateOutcome): void {
  if (o.status === "generated") {
    const scale = o.scale !== null && o.scale < 1 ? ` (scaled to ${o.scale})` : "";
    const what = o.pdfPath ?? "cover letter only";
    console.log(`✓ ${o.jobId} generated: ${what}${scale}${o.pdfPath && o.pageWarning ? " — still more than 1 page!" : ""}`);
    for (const w of o.warnings) console.log(`    warning: ${w}`);
  } else if (o.status === "blocked") {
    console.log(`✗ ${o.jobId} blocked:`);
    for (const e of o.errors) console.log(`    ${e}`);
  } else {
    console.log(`! quota exhausted at ${o.jobId}; remaining jobs stay pending for the next run`);
  }
}

async function runGenerate(jobIds: string[], mode: GenerateMode = "both"): Promise<void> {
  if (jobIds.length === 0) return console.log("nothing to generate");
  const usage = new UsageLog("generate");
  const outcomes = await generate(jobIds, {
    db: openDb(),
    config: loadConfig(),
    cv: loadBaseCv(),
    matcher: TechMatcher.load(),
    usage,
  }, mode);
  outcomes.forEach(printOutcome);
  console.log(usage.finish());
  if (outcomes.some((o) => o.status !== "generated")) process.exitCode = 1;
}

program
  .command("add")
  .description("add a job from a pasted .txt and generate its CV + cover letter")
  .argument("<file>", "text file with the job description")
  .option("--url <link>", "where to apply (stored as the apply URL)")
  .action(async (file: string, opts: { url?: string }) => {
    const db = openDb();
    const r = addManualJobFromFile(db, file, opts.url);
    const { jobId } = r;
    console.log(
      r.created
        ? `added job ${jobId}`
        : r.existing === "same_link"
          ? `that link is job ${jobId}, already collected (${r.status}); generating it`
          : `already added as job ${jobId}; generating again`,
    );
    runScoring({ db, config: loadConfig(), cv: loadBaseCv(), matcher: TechMatcher.load() }, { jobIds: [jobId] });
    await runGenerate([jobId]);
  });

program
  .command("generate")
  .description("tailoring + guard + render for pending jobs")
  .option("--limit <n>", "max jobs this run", (v) => Number.parseInt(v, 10))
  .option("--only <part>", "write only the CV (cv) or only the cover letter (cover-letter)")
  .action(async (opts: { limit?: number; only?: string }) => {
    const mode = opts.only === undefined ? "both" : ({ cv: "cv", "cover-letter": "cover_letter" } as const)[opts.only as "cv"];
    if (!mode) {
      console.error(`--only must be cv or cover-letter`);
      process.exitCode = 1;
      return;
    }
    const config = loadConfig();
    await runGenerate(pendingJobIds(openDb(), config, opts.limit ?? config.limits.generate_per_run), mode);
  });

async function runCollect(opts: { source?: string; force?: boolean }): Promise<void> {
  const all: string[] = [...JOBSPY_SITES, ...API_SOURCES];
  if (opts.source && !all.includes(opts.source)) {
    console.error(`unknown source ${opts.source}; available: ${all.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const db = openDb();
  const jobspySites = opts.source ? JOBSPY_SITES.filter((s) => s === opts.source) : [...JOBSPY_SITES];
  if (config.sources.jobspy.enabled && jobspySites.length > 0) {
    const s = await collectJobspy(db, config, { sites: jobspySites, force: opts.force });
    console.log(`jobspy: ${s.created} new, ${s.linked} linked to existing jobs, ${s.flagged} possible duplicates, ${s.seenAgain} seen again, ${s.invalid} invalid dropped`);
    if (s.skipped.length) console.log(`  skipped (blocked until midnight): ${s.skipped.join(", ")}`);
    if (s.blocked.length) console.log(`  blocked now (until midnight): ${s.blocked.join(", ")}`);
    for (const e of s.errors) console.log(`  error: ${e}`);
    if (s.errors.length) process.exitCode = 1;
  }
  const apiSources = opts.source ? API_SOURCES.filter((s) => s === opts.source) : [...API_SOURCES];
  for (const s of await collectApiSources(db, config, { sources: apiSources, force: opts.force })) {
    if (s.status === "disabled" || s.status === "skipped") {
      console.log(`${s.source}: ${s.status} (${s.detail})`);
      continue;
    }
    const blocked = s.status === "blocked" ? ` — BLOCKED until midnight (${s.detail})` : "";
    console.log(`${s.source}: ${s.created} new, ${s.linked} linked, ${s.flagged} possible duplicates, ${s.seenAgain} seen again${blocked}`);
    for (const e of s.errors) console.log(`  error: ${e}`);
    if (s.status === "error") process.exitCode = 1;
  }
}

function runScore(opts: { all?: boolean }): void {
  const config = loadConfig();
  const s = runScoring({ db: openDb(), config, cv: loadBaseCv(), matcher: TechMatcher.load() }, opts);
  const filtered = Object.values(s.filteredOut).reduce((a, b) => a + b, 0);
  console.log(`score: ${s.scored} scored (${s.aboveThreshold} at/above ${config.thresholds.generate}), ${s.analysis} to Analysis, ${filtered} filtered out`);
  for (const [why, n] of Object.entries(s.filteredOut).sort((a, b) => b[1] - a[1])) console.log(`  filtered: ${n} × ${why}`);
}

program
  .command("collect")
  .description("collect jobs: JobSpy sidecar (LinkedIn, Indeed, Glassdoor, Google) + public APIs (Gupy, Greenhouse, Lever, Ashby, Remotive)")
  .option("--source <name>", `only this source (${[...JOBSPY_SITES, ...API_SOURCES].join(", ")})`)
  .option("--force", "ignore today's block on a source (use with care: rule 3)")
  .action(runCollect);

program
  .command("score")
  .description("pre-filter + deterministic scoring of new jobs (no LLM)")
  .option("--all", "re-evaluate filtered_out, scored and analysis jobs too (e.g. after changing config)")
  .action(runScore);

program
  .command("run")
  .description("collect → score → generate")
  .option("--force", "ignore today's collector blocks (use with care: rule 3)")
  .action(async (opts: { force?: boolean }) => {
    await runCollect({ force: opts.force });
    runScore({});
    const config = loadConfig();
    await runGenerate(pendingJobIds(openDb(), config, config.limits.generate_per_run));
  });

program
  .command("review")
  .description("build the review panel and serve it with its API on localhost")
  .option("--port <n>", "port", (v) => Number.parseInt(v, 10), 4321)
  .action(async (opts: { port: number }) => {
    // Each server gets its own build: rebuilding the panel elsewhere can't swap the UI under a running API.
    const { build } = await import("vite");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const webDir = mkdtempSync(join(tmpdir(), "jobpipe-web-"));
    await build({ configFile: "web/vite.config.ts", logLevel: "warn", build: { outDir: webDir, emptyOutDir: true } });
    const { serve } = await import("@hono/node-server");
    const { createApp } = await import("./server.js");
    const app = createApp({
      db: openDb(),
      config: loadConfig(),
      cv: loadBaseCv(),
      matcher: TechMatcher.load(),
      outputDir: "output",
      webDir,
    });
    serve({ fetch: app.fetch, port: opts.port, hostname: "127.0.0.1" }, ({ port }) =>
      console.log(`review panel: http://localhost:${port}  (Ctrl+C to stop)`),
    );
  });

const companiesCmd = program.command("companies").description("company catalog: boards on Greenhouse, Lever and Ashby");

companiesCmd
  .command("import")
  .description("add boards from a file: one per line — a board URL, ats:slug, or a bare slug (all three ATSs are tried)")
  .argument("<file>")
  .action((file: string) => {
    const db = openDb();
    syncCompanies(db);
    const r = importBoards(db, file);
    console.log(`import: ${r.added} added, ${r.known} already known${r.invalid.length ? `, ${r.invalid.length} not understood` : ""}`);
    for (const line of r.invalid) console.log(`  ? ${line}`);
    if (r.added) console.log("next: pnpm jobpipe companies check");
  });

companiesCmd
  .command("check")
  .description("fetch each board once (unchecked or older than 7 days) and record open/dev/fitting jobs")
  .option("--all", "re-check every board")
  .action(async (opts: { all?: boolean }) => {
    const db = openDb();
    const config = loadConfig();
    syncCompanies(db);
    const { politeHttp } = await import("./collectors/http.js");
    const s = await checkBoards(db, config, politeHttp(config.limits.request_delay_seconds * 1000), opts);
    console.log(`check: ${s.checked} boards — ${s.ok} ok, ${s.notFound} not found${s.removedGuesses ? ` (${s.removedGuesses} guessed boards removed)` : ""}, ${s.errors.length} errors`);
    for (const e of s.errors) console.log(`  error: ${e}`);
    if (s.blocked.length) console.log(`  BLOCKED until midnight: ${s.blocked.join(", ")} — the rest of those boards were not checked`);
  });

companiesCmd
  .command("list")
  .description("companies with boards, followed first (the panel's Companies tab has more)")
  .action(async () => {
    const db = openDb();
    syncCompanies(db);
    const { listCompanies } = await import("./review.js");
    const rows = listCompanies({ db, config: loadConfig(), cv: loadBaseCv(), matcher: TechMatcher.load(), outputDir: "output" }).filter(
      (c) => c.boards.length > 0 || c.followed,
    );
    if (rows.length === 0) return console.log("no company boards yet — collect jobs or run pnpm jobpipe companies import <file>");
    for (const c of rows) {
      const boards = c.boards
        .map((b) => `${b.ats}:${b.slug} ${b.checkStatus === "ok" ? `${b.fitJobs}/${b.devJobs}/${b.openJobs}` : b.checkStatus}`)
        .join(", ");
      console.log(`${c.followed ? "★" : " "} ${c.name.padEnd(28)} ${boards}${c.jobs ? `  · ${c.jobs} jobs collected` : ""}`);
    }
    console.log("counts: fitting (remote/Brazil/LatAm dev roles) / dev roles / open jobs");
  });

program
  .command("stats")
  .description("jobs by status, this month's LLM tokens and equivalent cost, last quota reading, collectors")
  .action(() => console.log(formatStats(computeStats(openDb()))));

await program.parseAsync();

import { Command } from "commander";
import { API_SOURCES, collectApiSources } from "./collectors/api.js";
import { collectJobspy, JOBSPY_SITES } from "./collectors/jobspy.js";
import { addManualJob } from "./collectors/manual.js";
import { loadConfig } from "./config.js";
import { loadBaseCv } from "./cv/schema.js";
import { openDb } from "./db/index.js";
import { formatResults, runDoctor } from "./doctor.js";
import { generate, type GenerateOutcome, pendingJobIds } from "./generate.js";
import { runScoring } from "./scoring.js";
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

const notYet = (name: string, phase: number) =>
  program
    .command(name)
    .description(`(not implemented yet — phase ${phase})`)
    .allowUnknownOption()
    .action(() => {
      console.error(`${name}: not implemented yet (build phase ${phase})`);
      process.exitCode = 1;
    });

function printOutcome(o: GenerateOutcome): void {
  if (o.status === "generated") {
    const scale = o.scale < 1 ? ` (scaled to ${o.scale})` : "";
    console.log(`✓ ${o.jobId} generated: ${o.pdfPath}${scale}${o.pageWarning ? " — still more than 1 page!" : ""}`);
    for (const w of o.warnings) console.log(`    warning: ${w}`);
  } else if (o.status === "blocked") {
    console.log(`✗ ${o.jobId} blocked:`);
    for (const e of o.errors) console.log(`    ${e}`);
  } else {
    console.log(`! quota exhausted at ${o.jobId}; remaining jobs stay pending for the next run`);
  }
}

async function runGenerate(jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return console.log("nothing to generate");
  const usage = new UsageLog("generate");
  const outcomes = await generate(jobIds, {
    db: openDb(),
    config: loadConfig(),
    cv: loadBaseCv(),
    matcher: TechMatcher.load(),
    usage,
  });
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
    const { jobId, created } = addManualJob(db, file, opts.url);
    console.log(created ? `added job ${jobId}` : `already added as job ${jobId}; generating again`);
    runScoring({ db, config: loadConfig(), cv: loadBaseCv(), matcher: TechMatcher.load() }, { jobIds: [jobId] });
    await runGenerate([jobId]);
  });

program
  .command("generate")
  .description("tailoring + guard + render for pending jobs")
  .option("--limit <n>", "max jobs this run", (v) => Number.parseInt(v, 10))
  .action(async (opts: { limit?: number }) => {
    const config = loadConfig();
    await runGenerate(pendingJobIds(openDb(), config, opts.limit ?? config.limits.generate_per_run));
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

notYet("review", 6);
notYet("stats", 7);

await program.parseAsync();

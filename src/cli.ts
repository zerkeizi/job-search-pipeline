import { Command } from "commander";
import { collectJobspy, JOBSPY_SITES, type JobspySite } from "./collectors/jobspy.js";
import { addManualJob } from "./collectors/manual.js";
import { loadConfig } from "./config.js";
import { loadBaseCv } from "./cv/schema.js";
import { openDb } from "./db/index.js";
import { formatResults, runDoctor } from "./doctor.js";
import { generate, type GenerateOutcome, pendingJobIds } from "./generate.js";
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
    const { jobId, created } = addManualJob(openDb(), file, opts.url);
    console.log(created ? `added job ${jobId}` : `already added as job ${jobId}; generating again`);
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

program
  .command("collect")
  .description("collect jobs (LinkedIn, Indeed, Glassdoor, Google Jobs via the JobSpy sidecar)")
  .option("--source <site>", `only this source (${JOBSPY_SITES.join(", ")})`)
  .option("--force", "ignore today's block on a source (use with care: rule 3)")
  .action(async (opts: { source?: string; force?: boolean }) => {
    if (opts.source && !JOBSPY_SITES.includes(opts.source as JobspySite)) {
      console.error(`unknown source ${opts.source}; available: ${JOBSPY_SITES.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const config = loadConfig();
    if (!config.sources.jobspy.enabled) return console.log("jobspy is disabled in config.yaml");
    const s = await collectJobspy(openDb(), config, {
      sites: opts.source ? [opts.source as JobspySite] : undefined,
      force: opts.force,
    });
    console.log(`jobspy: ${s.created} new, ${s.seenAgain} seen again, ${s.invalid} invalid dropped`);
    if (s.skipped.length) console.log(`skipped (blocked until midnight): ${s.skipped.join(", ")}`);
    if (s.blocked.length) console.log(`blocked now (until midnight): ${s.blocked.join(", ")}`);
    for (const e of s.errors) console.log(`error: ${e}`);
    if (s.errors.length) process.exitCode = 1;
  });

notYet("score", 5);
notYet("run", 5);
notYet("review", 6);
notYet("stats", 7);

await program.parseAsync();

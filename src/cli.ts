import { Command } from "commander";
import { formatResults, runDoctor } from "./doctor.js";

const program = new Command().name("jobpipe").description("Collect, score and tailor job applications");

program
  .command("doctor")
  .description("check node, pnpm, uv, sidecar, playwright, .env, config and CV files")
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

notYet("add", 2);
notYet("generate", 2);
notYet("collect", 3);
notYet("score", 5);
notYet("run", 5);
notYet("review", 6);
notYet("stats", 7);

await program.parseAsync();

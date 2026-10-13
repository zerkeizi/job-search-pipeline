// Stands in for the JobSpy sidecar in tests. FAKE_SIDECAR_MODE: ok | blocked | error | hang.
// Records the received input in FAKE_SIDECAR_INPUTS (a file, one JSON per line) if set.
import { appendFileSync } from "node:fs";

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const input = JSON.parse(stdin);
if (process.env.FAKE_SIDECAR_INPUTS) appendFileSync(process.env.FAKE_SIDECAR_INPUTS, stdin + "\n");
const mode = process.env.FAKE_SIDECAR_MODE ?? "ok";

const job = (site, n) => ({
  id: `${site}-${input.search_term.replace(/\W/g, "")}-${n}`,
  site,
  job_url: `https://${site}.example/jobs/${n}`,
  job_url_direct: n === 1 ? `https://boards.greenhouse.io/acme/jobs/${n}` : null,
  title: "Senior Full-stack Developer",
  company: "Acme",
  location: "Porto Alegre, RS, Brazil",
  date_posted: "2026-10-12",
  interval: null, min_amount: null, max_amount: null, currency: null,
  is_remote: n === 2,
  work_from_home_type: null,
  description: `We use React and Node. (${site} #${n})`,
  company_rating: 4.2,
});

if (mode === "hang") setInterval(() => {}, 1000);
else {
if (mode === "error") { process.stderr.write("Traceback: boom\n"); process.exit(1); }

const blockLinkedin = mode === "blocked" && input.sites.includes("linkedin");
const sites = blockLinkedin ? input.sites.filter((s) => s !== "linkedin") : input.sites;
const rows = sites.flatMap((s) => [job(s, 1), job(s, 2)]);
rows.push({ id: "bad", site: "indeed" }); // invalid: must be dropped, not crash the batch
rows.push({ ...job("indeed", 3), description: null }); // no description: dropped
process.stdout.write(JSON.stringify(rows));
if (blockLinkedin) {
  process.stderr.write("linkedin: HTTP 429\n" + JSON.stringify({ blocked: ["linkedin"] }) + "\n");
  process.exit(2);
}
}

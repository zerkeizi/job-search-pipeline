// Stands in for the `claude` CLI in tests: prints stream-json like `claude -p --output-format stream-json`.
// FAKE_CLAUDE_MODE: ok | quota | apikey | error | silent. FAKE_CLAUDE_OUTPUT: JSON for structured_output.
// FAKE_CLAUDE_ARGS_FILE: if set, the received argv and stdin are written there.
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify({ argv: process.argv.slice(2), stdin, env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null } }));
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

out({ type: "system", subtype: "init", apiKeySource: mode === "apikey" ? "ANTHROPIC_API_KEY" : "none", model: "claude-sonnet-5-5" });
if (mode === "silent") process.exit(1);
const windows = { five_hour: { utilization: 0.21, resetsAt: 1791931200 }, seven_day: { utilization: 0.05, resetsAt: 1792497600 } };
out({ type: "rate_limit_event", rate_limit_info: { status: mode === "quota" ? "rejected" : "allowed", unifiedWindows: windows } });
out({
  type: "result",
  subtype: mode === "error" ? "error_during_execution" : "success",
  is_error: mode === "error" || mode === "quota",
  result: mode === "quota" ? "You've hit your usage limit" : mode === "error" ? "boom" : "",
  structured_output: mode === "ok" ? JSON.parse(process.env.FAKE_CLAUDE_OUTPUT ?? "{}") : undefined,
  usage: { input_tokens: 2130, cache_creation_input_tokens: 600, cache_read_input_tokens: 0, output_tokens: 1480 },
  modelUsage: { "claude-sonnet-5-5": {} },
  total_cost_usd: 0.031,
});

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/**
 * Every LLM call goes through the installed Claude Code CLI signed in with my subscription
 * (ADR 0005): never the paid API, never `--bare` (it ignores the subscription).
 */

export interface QuotaWindow {
  /** Share of the window already used, 0..1. */
  used: number;
  resetsAt: Date;
}

export interface Quota {
  status: string;
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** What the call would cost on the API; not billed. */
  equivalentCostUsd: number;
}

export interface LlmResult {
  output: unknown;
  usage: LlmUsage;
  quota?: Quota;
}

export interface LlmRequest {
  model: string;
  systemPrompt: string;
  prompt: string;
  jsonSchema: object;
  timeoutMs: number;
}

export class QuotaExhaustedError extends Error {
  constructor(readonly quota?: Quota) {
    super("Claude subscription quota exhausted; try again after it resets");
  }
}

export class LlmError extends Error {}

export interface ClaudeRunner {
  command: string;
  /** Arguments placed before the CLI flags (lets tests run a fake CLI through `node`). */
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export const defaultRunner: ClaudeRunner = { command: "claude" };

export function claudeArgs(req: LlmRequest): string[] {
  return [
    "-p",
    "--model", req.model,
    "--system-prompt", req.systemPrompt,
    "--tools", "",
    "--no-session-persistence",
    // Keep per-call overhead low (~600 tokens instead of ~10k): no settings, skills, MCP or dynamic sections.
    "--setting-sources", "",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--exclude-dynamic-system-prompt-sections",
    "--output-format", "stream-json",
    "--verbose",
    "--json-schema", JSON.stringify(req.jsonSchema),
  ];
}

interface StreamWindow {
  utilization?: number;
  resetsAt?: number;
}

function toWindow(w: StreamWindow | undefined): QuotaWindow | undefined {
  if (w?.utilization === undefined || w.resetsAt === undefined) return undefined;
  return { used: w.utilization, resetsAt: new Date(w.resetsAt * 1000) };
}

export async function callClaude(req: LlmRequest, runner: ClaudeRunner = defaultRunner): Promise<LlmResult> {
  const env = { ...(runner.env ?? process.env) };
  delete env.ANTHROPIC_API_KEY; // would switch Claude Code to per-token API billing
  // A neutral working directory, so no project CLAUDE.md, hooks or skills are picked up.
  const cwd = join(tmpdir(), "jobpipe-llm");
  mkdirSync(cwd, { recursive: true });

  const child = spawn(runner.command, [...(runner.prefixArgs ?? []), ...claudeArgs(req)], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(req.prompt);

  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

  let quota: Quota | undefined;
  let result: Record<string, unknown> | undefined;
  let abort: Error | undefined;
  const timer = setTimeout(() => {
    abort = new LlmError(`claude timed out after ${req.timeoutMs / 1000}s`);
    child.kill("SIGINT");
  }, req.timeoutMs);

  const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.trim()) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (msg.type === "system" && msg.subtype === "init" && msg.apiKeySource !== "none") {
      abort = new LlmError(`refusing to run: claude is using API key source "${String(msg.apiKeySource)}"`);
      child.kill("SIGINT");
    } else if (msg.type === "rate_limit_event") {
      const info = (msg.rate_limit_info ?? {}) as { status?: string; unifiedWindows?: Record<string, StreamWindow> };
      quota = {
        status: info.status ?? "unknown",
        fiveHour: toWindow(info.unifiedWindows?.five_hour),
        sevenDay: toWindow(info.unifiedWindows?.seven_day),
      };
    } else if (msg.type === "result") {
      result = msg;
    }
  }
  const code = await exit;
  clearTimeout(timer);

  if (abort) throw abort;
  if (quota && quota.status !== "allowed" && quota.status !== "allowed_warning") throw new QuotaExhaustedError(quota);
  if (!result) throw new LlmError(`claude exited with code ${code} and no result. ${stderr.slice(0, 500)}`);
  if (result.is_error) {
    const text = String(result.result ?? "");
    if (/rate.?limit|usage limit/i.test(text) || result.api_error_status === 429) throw new QuotaExhaustedError(quota);
    throw new LlmError(`claude returned an error: ${text.slice(0, 500)}`);
  }
  if (result.structured_output === undefined) throw new LlmError("claude returned no structured output");

  const usage = (result.usage ?? {}) as Record<string, number>;
  const model = Object.keys((result.modelUsage ?? {}) as object)[0] ?? req.model;
  return {
    output: result.structured_output,
    quota,
    usage: {
      model,
      inputTokens: usage.input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      equivalentCostUsd: Number(result.total_cost_usd ?? 0),
    },
  };
}

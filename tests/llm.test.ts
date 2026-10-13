import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callClaude, type ClaudeRunner, LlmError, QuotaExhaustedError } from "../src/llm.js";
import { UsageLog } from "../src/usage.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "jobpipe-llm-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function fake(mode: string, extra: NodeJS.ProcessEnv = {}): ClaudeRunner {
  return {
    command: process.execPath,
    prefixArgs: [join(process.cwd(), "tests/fixtures/fake-claude.mjs")],
    env: { ...process.env, FAKE_CLAUDE_MODE: mode, ...extra },
  };
}

const request = { model: "sonnet", systemPrompt: "sys", prompt: "the prompt", jsonSchema: { type: "object" }, timeoutMs: 10_000 };

describe("callClaude", () => {
  it("returns structured output, usage and quota", async () => {
    const r = await callClaude(request, fake("ok", { FAKE_CLAUDE_OUTPUT: '{"answer":42}' }));
    expect(r.output).toEqual({ answer: 42 });
    expect(r.usage).toMatchObject({ model: "claude-sonnet-5-5", inputTokens: 2130, outputTokens: 1480, equivalentCostUsd: 0.031 });
    expect(r.quota?.fiveHour?.used).toBe(0.21);
  });

  it("sends the prompt on stdin, disables tools and never passes an API key", async () => {
    const file = join(tmp(), "args.json");
    await callClaude(request, fake("ok", { FAKE_CLAUDE_ARGS_FILE: file, ANTHROPIC_API_KEY: "sk-test" }));
    const seen = JSON.parse(readFileSync(file, "utf8"));
    expect(seen.stdin).toBe("the prompt");
    expect(seen.env.ANTHROPIC_API_KEY).toBeNull();
    expect(seen.argv).toEqual(expect.arrayContaining(["-p", "--tools", "", "--setting-sources"]));
    expect(seen.argv).not.toContain("--bare");
  });

  it("refuses to run when Claude Code reports an API key", async () => {
    await expect(callClaude(request, fake("apikey"))).rejects.toThrow(/API key/);
  });

  it("raises QuotaExhaustedError when the subscription limit is hit", async () => {
    await expect(callClaude(request, fake("quota"))).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  it("raises LlmError on other failures", async () => {
    await expect(callClaude(request, fake("error"))).rejects.toBeInstanceOf(LlmError);
    await expect(callClaude(request, fake("silent"))).rejects.toBeInstanceOf(LlmError);
  });
});

describe("UsageLog", () => {
  it("logs each call and a summary with quota used and remaining", async () => {
    const dir = tmp();
    const log = new UsageLog("generate", dir, () => new Date(2026, 9, 13, 14, 2, 11));
    const r = await callClaude(request, fake("ok"));
    log.record(r.usage, r.quota, "ab12f");
    const summary = log.finish();
    expect(summary).toContain("calls: 1");
    expect(summary).toContain("quota remaining: 5h 79%");
    const [file] = readdirSync(dir);
    expect(file).toBe("2026-10-13_usage.log");
    const text = readFileSync(join(dir, file!), "utf8");
    expect(text).toContain("job=ab12f");
    expect(text).toContain("quota 5h=21% 7d=5%");
  });
});

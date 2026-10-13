import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { loadConfig } from "./config.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorEnv {
  nodeVersion: string;
  envVars: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  /** Runs a command without a shell; returns trimmed stdout, or null if it failed. */
  run: (cmd: string, args: string[]) => string | null;
}

export const defaultEnv: DoctorEnv = {
  nodeVersion: process.versions.node,
  envVars: process.env,
  exists: existsSync,
  readFile: (path) => readFileSync(path, "utf8"),
  run: (cmd, args) => {
    const res = spawnSync(cmd, args, { encoding: "utf8" });
    return res.status === 0 ? res.stdout.trim() : null;
  },
};

export function checkNode(env: DoctorEnv): CheckResult {
  const major = Number(env.nodeVersion.split(".")[0]);
  return major >= 22
    ? { name: "node", status: "ok", detail: `v${env.nodeVersion}` }
    : { name: "node", status: "fail", detail: `v${env.nodeVersion}, need >= 22` };
}

export function checkPnpm(env: DoctorEnv): CheckResult {
  const version = env.run("pnpm", ["--version"]);
  return version
    ? { name: "pnpm", status: "ok", detail: version }
    : { name: "pnpm", status: "fail", detail: "not found" };
}

export function checkUv(env: DoctorEnv): CheckResult {
  const version = env.run("uv", ["--version"]);
  return version
    ? { name: "uv", status: "ok", detail: version }
    : { name: "uv", status: "warn", detail: "not found (needed by the JobSpy sidecar, phase 3)" };
}

export function checkSidecar(env: DoctorEnv): CheckResult {
  return env.exists("sidecar/jobspy/pyproject.toml")
    ? { name: "sidecar", status: "ok", detail: "sidecar/jobspy present" }
    : { name: "sidecar", status: "warn", detail: "sidecar/jobspy missing (phase 3)" };
}

export function checkPlaywright(env: DoctorEnv): CheckResult {
  const version = env.run("pnpm", ["exec", "playwright", "--version"]);
  return version
    ? { name: "playwright", status: "ok", detail: version }
    : { name: "playwright", status: "fail", detail: "not installed (pnpm exec playwright install chromium)" };
}

export function checkClaudeAuth(env: DoctorEnv): CheckResult {
  const out = env.run("claude", ["auth", "status"]);
  if (out === null) return { name: "claude", status: "fail", detail: "Claude Code CLI not found or not logged in" };
  try {
    const status = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    if (!status.loggedIn) return { name: "claude", status: "fail", detail: "not logged in (run `claude` and /login)" };
    if (status.authMethod !== "claude.ai") {
      return { name: "claude", status: "fail", detail: `logged in via ${status.authMethod}, expected a claude.ai subscription` };
    }
    return { name: "claude", status: "ok", detail: `subscription (${status.subscriptionType ?? "unknown plan"})` };
  } catch {
    return { name: "claude", status: "fail", detail: "could not parse `claude auth status`" };
  }
}

/** An API key would make `claude -p` bill per token instead of using the subscription (ADR 0005). */
export function checkNoApiKey(env: DoctorEnv): CheckResult {
  const inDotenv = env.exists(".env") && Boolean(parseDotenv(env.readFile(".env")).ANTHROPIC_API_KEY);
  // Only report presence; never print secret values.
  if (env.envVars.ANTHROPIC_API_KEY || inDotenv) {
    return {
      name: "no API key",
      status: "fail",
      detail: `ANTHROPIC_API_KEY is set${inDotenv ? " in .env" : " in the environment"} — remove it to avoid API charges`,
    };
  }
  return { name: "no API key", status: "ok", detail: "ANTHROPIC_API_KEY not set" };
}

export function checkConfig(): CheckResult {
  try {
    loadConfig();
    return { name: "config.yaml", status: "ok", detail: "valid" };
  } catch (err) {
    return { name: "config.yaml", status: "fail", detail: err instanceof Error ? err.message : String(err) };
  }
}

export function checkFonts(env: DoctorEnv): CheckResult {
  try {
    const { font_dir, fonts } = loadConfig().render;
    const missing = [fonts.regular, fonts.bold].filter((f) => !env.exists(join(font_dir, f)));
    return missing.length === 0
      ? { name: "CV fonts", status: "ok", detail: font_dir }
      : { name: "CV fonts", status: "fail", detail: `missing in ${font_dir}: ${missing.join(", ")}` };
  } catch {
    return { name: "CV fonts", status: "fail", detail: "config.yaml render section invalid" };
  }
}

export function checkCvFiles(env: DoctorEnv): CheckResult[] {
  return ["cv/original.pdf", "cv/base.yaml", "cv/template/cv.hbs", "cv/template/cv.css"].map((path) =>
    env.exists(path)
      ? { name: path, status: "ok", detail: "present" }
      : { name: path, status: "fail", detail: "missing" },
  );
}

export function runDoctor(env: DoctorEnv = defaultEnv): CheckResult[] {
  return [
    checkNode(env),
    checkPnpm(env),
    checkUv(env),
    checkSidecar(env),
    checkPlaywright(env),
    checkClaudeAuth(env),
    checkNoApiKey(env),
    checkConfig(),
    checkFonts(env),
    ...checkCvFiles(env),
  ];
}

const icons: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatResults(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  return results.map((r) => `${icons[r.status]} ${r.name.padEnd(width)}  ${r.detail}`).join("\n");
}

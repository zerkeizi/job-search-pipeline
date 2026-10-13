import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  /** Runs a command without a shell; returns trimmed stdout, or null if it failed. */
  run: (cmd: string, args: string[]) => string | null;
}

export const defaultEnv: DoctorEnv = {
  nodeVersion: process.versions.node,
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

export function checkEnvFile(env: DoctorEnv): CheckResult {
  if (!env.exists(".env")) {
    return { name: ".env", status: "fail", detail: "missing (copy .env.example)" };
  }
  // Only report presence; never print secret values.
  const vars = parseDotenv(env.readFile(".env"));
  return vars.ANTHROPIC_API_KEY
    ? { name: ".env", status: "ok", detail: "ANTHROPIC_API_KEY set" }
    : { name: ".env", status: "fail", detail: "ANTHROPIC_API_KEY empty" };
}

export function checkConfig(): CheckResult {
  try {
    loadConfig();
    return { name: "config.yaml", status: "ok", detail: "valid" };
  } catch (err) {
    return { name: "config.yaml", status: "fail", detail: err instanceof Error ? err.message : String(err) };
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
    checkEnvFile(env),
    checkConfig(),
    ...checkCvFiles(env),
  ];
}

const icons: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatResults(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  return results.map((r) => `${icons[r.status]} ${r.name.padEnd(width)}  ${r.detail}`).join("\n");
}

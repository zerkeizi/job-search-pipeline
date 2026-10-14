import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { type Browser, chromium } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadBaseCv } from "../src/cv/schema.js";
import { openDb } from "../src/db/index.js";
import { jobs } from "../src/db/schema.js";
import { ingest, type PostingIn } from "../src/ingest.js";
import { createApp } from "../src/server.js";
import { TechMatcher } from "../src/tech.js";

// The real panel in a real browser, against an in-memory database.
const dir = mkdtempSync(join(tmpdir(), "jobpipe-panel-"));
let server: ServerType;
let browser: Browser;
let base: string;

function posting(externalId: string, company: string): PostingIn {
  return {
    source: "gupy", externalId, url: `https://acme.example/${externalId}`, applyUrl: null, company,
    title: "Full Stack Developer", location: null, workplace: "remote", salaryMin: null, salaryMax: null,
    salaryCurrency: null, salaryInterval: null, description: `Opening ${externalId} with React and Node`, postedAt: null,
  };
}

beforeAll(async () => {
  const webDir = join(dir, "web");
  await build({ configFile: "web/vite.config.ts", logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  const db = openDb(":memory:");
  const config = loadConfig();
  ingest(db, [posting("1", "Acme"), posting("2", "Beta")], config.dedupe);
  db.update(jobs).set({ status: "scored", score: 80 }).where(eq(jobs.company, "Acme")).run();
  db.update(jobs).set({ status: "generated", score: 75 }).where(eq(jobs.company, "Beta")).run();
  const app = createApp({ db, config, cv: loadBaseCv(), matcher: TechMatcher.load(), outputDir: join(dir, "out"), webDir, logDir: join(dir, "logs") });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("review panel", () => {
  it("does not keep calling the API while idle on any tab", async () => {
    const page = await browser.newPage();
    const calls: string[] = [];
    const errors: string[] = [];
    page.on("request", (r) => r.url().includes("/api/") && calls.push(new URL(r.url()).pathname));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    for (const tab of ["Queue", "Generated", "Applied", "Analysis", "Companies", "Collectors"]) {
      await page.getByRole("button", { name: new RegExp(`^${tab}`) }).click();
      await page.waitForTimeout(400);
      const before = calls.length;
      await page.waitForTimeout(1500); // idle
      expect(calls.slice(before), `requests while idle on ${tab}`).toEqual([]);
    }
    expect(errors).toEqual([]);
  }, 60_000);
});

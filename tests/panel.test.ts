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
import type { ClaudeRunner } from "../src/llm.js";
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
  // Fake claude answering a cover-letter-only tailoring (no PDF to render).
  const letter = {
    keywords: ["React"], strong_matches: ["React"], gaps: [],
    cover_letter: "Dear hiring team,\n\nI build web products with React and Node.\n\nNicolas Villanova",
    job: { company: "Acme", title: "Full Stack Developer", workplace: "remote", office_city: null, office_days_per_week: null },
  };
  const runner: ClaudeRunner = {
    command: process.execPath,
    prefixArgs: [join(process.cwd(), "tests/fixtures/fake-claude.mjs")],
    env: { ...process.env, FAKE_CLAUDE_MODE: "ok", FAKE_CLAUDE_OUTPUT: JSON.stringify(letter) },
  };
  const app = createApp({
    db, config, cv: loadBaseCv(), matcher: TechMatcher.load(), outputDir: join(dir, "out"), webDir, logDir: join(dir, "logs"), runner,
  });
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
  it("adds a job from the Add job dialog and shows it in the Queue", async () => {
    const page = await browser.newPage();
    await page.goto(base);
    await page.getByRole("button", { name: "+ Add job" }).click();
    await page.getByPlaceholder("Senior Full Stack Developer").fill("Backend Developer");
    await page.getByPlaceholder("Acme").fill("Hand Picked Co");
    await page.getByPlaceholder("Paste the full job description").fill("We need Node and React for our platform.");
    await page.getByRole("button", { name: "Save and add another" }).click();
    await page.getByText("Hand Picked Co added to the Queue.").waitFor();
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: /^Queue/ }).click();
    await page.locator(".item", { hasText: "Hand Picked Co" }).waitFor();
    expect(await page.locator("nav").innerText()).toMatch(/Queue\s*2/);
  }, 60_000);

  it("generates the selected jobs one after the other", async () => {
    const page = await browser.newPage();
    // Native confirm()/prompt() can be switched off by the browser: the panel must never use them.
    const native: string[] = [];
    page.on("dialog", (d) => {
      native.push(d.message());
      void d.dismiss();
    });
    await page.goto(base);
    await page.getByRole("button", { name: /^Queue/ }).click();
    await page.locator(".item", { hasText: "Hand Picked Co" }).waitFor();
    await page.getByRole("button", { name: "Select manual" }).click();
    await page.getByRole("button", { name: /Generate selected \(1\)/ }).click();
    await page.getByRole("button", { name: "Cover letter only" }).click();
    await page.getByRole("dialog").getByText(/One tailoring call each/).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Generate 1" }).click();
    await page.getByText("Generated 1 of 1").waitFor({ timeout: 30_000 });
    expect(native).toEqual([]);
    await page.getByRole("button", { name: /^Generated/ }).click();
    await page.locator(".item", { hasText: "Hand Picked Co" }).waitFor();

    // Discard asks for a reason in the in-page dialog; Escape cancels, Enter confirms.
    await page.locator(".item", { hasText: "Hand Picked Co" }).click();
    await page.locator(".job h2", { hasText: "Hand Picked Co" }).waitFor();
    await page.getByRole("button", { name: "Discard" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Discard" }).click();
    await page.getByRole("dialog").locator("input").fill("not for me");
    await page.keyboard.press("Enter");
    await page.locator(".item", { hasText: "Hand Picked Co" }).waitFor({ state: "detached" });
    expect(native).toEqual([]);
  }, 60_000);

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

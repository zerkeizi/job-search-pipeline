import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { collectorState, jobs } from "./db/schema.js";
import { JOB_STATUSES, type JobStatus } from "./status.js";

/** One LLM call as written by UsageLog.record. */
export interface UsageEntry {
  at: string;
  stage: string;
  model: string;
  jobId: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  costUsd: number;
  quota5h: string;
  quota7d: string;
}

export interface QuotaReading {
  /** When the reading was logged ("YYYY-MM-DD HH:MM"). */
  at: string;
  fiveHourRemaining: string;
  fiveHourResets: string;
  sevenDayRemaining: string;
  sevenDayResets: string;
}

const num = (s: string) => Number(s.replaceAll(",", ""));
const CALL =
  /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(\S+)\s+(\S+)\s+job=(\S+)\s+in=([\d,]+) cache_write=([\d,]+) cache_read=([\d,]+) out=([\d,]+)\s+~\$([\d.]+)\s+quota 5h=(\S+) 7d=(\S+)/;
const FINISHED = /^=== \S+ finished (\d{4}-\d\d-\d\d \d\d:\d\d)/;
const REMAINING = /^quota remaining: 5h (\S+) \(resets ([^)]+)\) · 7d (\S+) \(resets ([^)]+)\)/;

/** Reads every `<YYYY-MM-*>_usage.log` of a month: the calls and the last quota reading. */
export function readUsage(dir: string, month: string): { calls: UsageEntry[]; lastQuota: QuotaReading | null } {
  const calls: UsageEntry[] = [];
  let lastQuota: QuotaReading | null = null;
  if (!existsSync(dir)) return { calls, lastQuota };
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(month) && f.endsWith("_usage.log"))
    .sort();
  for (const file of files) {
    let finishedAt = "";
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      const c = CALL.exec(line);
      if (c) {
        calls.push({
          at: c[1]!, stage: c[2]!, model: c[3]!, jobId: c[4]!,
          input: num(c[5]!), cacheWrite: num(c[6]!), cacheRead: num(c[7]!), output: num(c[8]!),
          costUsd: Number(c[9]), quota5h: c[10]!, quota7d: c[11]!,
        });
        continue;
      }
      const f = FINISHED.exec(line);
      if (f) finishedAt = f[1]!;
      const r = REMAINING.exec(line);
      if (r) lastQuota = { at: finishedAt, fiveHourRemaining: r[1]!, fiveHourResets: r[2]!, sevenDayRemaining: r[3]!, sevenDayResets: r[4]! };
    }
  }
  return { calls, lastQuota };
}

export interface Stats {
  month: string;
  byStatus: Record<JobStatus, number>;
  newThisMonth: number;
  appliedThisMonth: number;
  usage: { calls: number; input: number; cacheWrite: number; cacheRead: number; output: number; costUsd: number; byStage: Record<string, number> };
  lastQuota: QuotaReading | null;
  collectors: { source: string; lastSuccessAt: string | null; lastCount: number | null; blockedUntil: string | null }[];
}

const pad = (n: number) => String(n).padStart(2, "0");
export const monthOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/** `jobpipe stats`: Jobs by status, this month's LLM usage (from the usage logs), last quota reading, collectors. */
export function computeStats(db: Db, logDir = "data/logs", now = new Date()): Stats {
  const month = monthOf(now);
  const byStatus = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
  for (const r of db.select({ status: jobs.status, n: sql<number>`count(*)` }).from(jobs).groupBy(jobs.status).all())
    byStatus[r.status] = r.n;

  // Timestamps are stored in UTC; compare against the local month's start.
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const count = (column: typeof jobs.firstSeenAt | typeof jobs.appliedAt) =>
    db.select({ n: sql<number>`count(*)` }).from(jobs).where(sql`${column} >= ${monthStart}`).get()?.n ?? 0;

  const { calls, lastQuota } = readUsage(logDir, month);
  const sum = (k: "input" | "cacheWrite" | "cacheRead" | "output" | "costUsd") => calls.reduce((s, c) => s + c[k], 0);
  const byStage: Record<string, number> = {};
  for (const c of calls) byStage[c.stage] = (byStage[c.stage] ?? 0) + 1;

  return {
    month,
    byStatus,
    newThisMonth: count(jobs.firstSeenAt),
    appliedThisMonth: count(jobs.appliedAt),
    usage: { calls: calls.length, input: sum("input"), cacheWrite: sum("cacheWrite"), cacheRead: sum("cacheRead"), output: sum("output"), costUsd: sum("costUsd"), byStage },
    lastQuota,
    collectors: db
      .select()
      .from(collectorState)
      .all()
      .map((r) => ({
        source: r.source,
        lastSuccessAt: r.lastSuccessAt,
        lastCount: r.lastCount,
        blockedUntil: r.blockedUntil && new Date(r.blockedUntil) > now ? r.blockedUntil : null,
      }))
      .sort((a, b) => a.source.localeCompare(b.source)),
  };
}

const int = (n: number) => n.toLocaleString("en-US");
const local = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "never";

/**
 * When a logged reset label ("19:40" on the reading's day, or "20/10 09:00") falls, as a local Date.
 * The subscription only reports quota during a call, so stats shows the last reading and says when
 * a window has reset since.
 */
export function resetTime(readingAt: string, label: string): Date | null {
  const [y, mo, d] = readingAt.slice(0, 10).split("-").map(Number) as [number, number, number];
  const m = /^(?:(\d\d)\/(\d\d) )?(\d\d):(\d\d)$/.exec(label);
  if (!m) return null;
  const day = m[1] ? Number(m[1]) : d;
  const month = m[2] ? Number(m[2]) : mo;
  const year = month < mo ? y + 1 : y;
  return new Date(year, month - 1, day, Number(m[3]), Number(m[4]));
}

export function formatStats(s: Stats, now = new Date()): string {
  const q = s.lastQuota;
  const window = (remaining: string, resets: string) => {
    const at = q ? resetTime(q.at, resets) : null;
    return at && at <= now ? `reset since (was ${remaining} left)` : `${remaining} left (resets ${resets})`;
  };
  const statusLine = JOB_STATUSES.map((st) => `${st} ${s.byStatus[st]}`).join(" · ");
  const u = s.usage;
  const stages = Object.entries(u.byStage).map(([k, v]) => `${k} ${v}`).join(", ");
  const lines = [
    `=== stats ${s.month} ===`,
    `jobs: ${statusLine}`,
    `this month: ${s.newThisMonth} new jobs, ${s.appliedThisMonth} applied`,
    "",
    `LLM (subscription, not billed): ${u.calls} calls${stages ? ` (${stages})` : ""}`,
    `  tokens: input ${int(u.input)} · cache write ${int(u.cacheWrite)} · cache read ${int(u.cacheRead)} · output ${int(u.output)}`,
    `  equivalent cost: ~$${u.costUsd.toFixed(2)}`,
    q
      ? `  quota at last call (${q.at}): 5h ${window(q.fiveHourRemaining, q.fiveHourResets)} · ` +
        `7d ${window(q.sevenDayRemaining, q.sevenDayResets)}`
      : "  quota: no reading this month",
    "",
    "collectors:",
    ...(s.collectors.length === 0
      ? ["  never run"]
      : s.collectors.map(
          (c) =>
            `  ${c.source.padEnd(10)} last success ${local(c.lastSuccessAt)}` +
            `${c.lastCount === null ? "" : ` (${c.lastCount} postings)`}` +
            `${c.blockedUntil ? `  BLOCKED until ${local(c.blockedUntil)}` : ""}`,
        )),
  ];
  return lines.join("\n");
}

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { collectorState } from "./db/schema.js";

/** Next local midnight: a blocked source stays off until then (rule 3). */
export function nextMidnight(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

export function isBlocked(db: Db, source: string, now: Date): boolean {
  const row = db.select().from(collectorState).where(eq(collectorState.source, source)).get();
  return Boolean(row?.blockedUntil && new Date(row.blockedUntil) > now);
}

export function markBlocked(db: Db, source: string, now: Date): void {
  const blockedUntil = nextMidnight(now).toISOString();
  db.insert(collectorState)
    .values({ source, blockedUntil })
    .onConflictDoUpdate({ target: collectorState.source, set: { blockedUntil } })
    .run();
}

export function markSuccess(db: Db, source: string, now: Date): void {
  const lastSuccessAt = now.toISOString();
  db.insert(collectorState)
    .values({ source, lastSuccessAt })
    .onConflictDoUpdate({ target: collectorState.source, set: { lastSuccessAt } })
    .run();
}

/**
 * Collection window in hours: since the source's last successful collection plus a margin,
 * capped at maxHours (also used on the first run).
 */
export function windowHours(db: Db, source: string, now: Date, marginHours: number, maxHours: number): number {
  const row = db.select().from(collectorState).where(eq(collectorState.source, source)).get();
  if (!row?.lastSuccessAt) return maxHours;
  const since = (now.getTime() - new Date(row.lastSuccessAt).getTime()) / 3_600_000;
  return Math.min(maxHours, Math.ceil(since + marginHours));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Appends to data/logs/<date>_collector.log. */
export function logCollector(line: string, now = new Date(), dir = "data/logs"): void {
  mkdirSync(dir, { recursive: true });
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  appendFileSync(join(dir, `${day}_collector.log`), `${day} ${time}  ${line}\n`);
}

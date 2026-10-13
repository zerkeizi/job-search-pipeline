import { eq } from "drizzle-orm";
import { isBlocked, logCollector, markBlocked, markSuccess, windowHours } from "../collector-state.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { collectorState } from "../db/schema.js";
import { ingest, type IngestResult } from "../ingest.js";
import { collectAshby } from "./ashby.js";
import { collectGreenhouse } from "./greenhouse.js";
import { collectGupy } from "./gupy.js";
import { BlockedError, type Http, politeHttp } from "./http.js";
import { collectLever } from "./lever.js";
import { collectRemotive } from "./remotive.js";
import { type ApiCollector, errorText } from "./types.js";

export const API_SOURCES = ["gupy", "greenhouse", "lever", "ashby", "remotive"] as const;
export type ApiSource = (typeof API_SOURCES)[number];

const COLLECTORS: Record<ApiSource, ApiCollector> = {
  gupy: collectGupy,
  greenhouse: collectGreenhouse,
  lever: collectLever,
  ashby: collectAshby,
  remotive: collectRemotive,
};

export interface ApiSourceSummary extends IngestResult {
  source: ApiSource;
  status: "ok" | "blocked" | "skipped" | "disabled" | "error";
  detail?: string;
  errors: string[];
}

function targetsOf(config: Config, source: ApiSource): number {
  if (source === "gupy") return config.sources.gupy.queries.length;
  if (source === "remotive") return 1;
  return config.sources[source].companies.length;
}

/** Hours since the last successful collection (Infinity if never). */
function hoursSinceSuccess(db: Db, source: string, now: Date): number {
  const row = db.select().from(collectorState).where(eq(collectorState.source, source)).get();
  return row?.lastSuccessAt ? (now.getTime() - new Date(row.lastSuccessAt).getTime()) / 3_600_000 : Infinity;
}

export interface ApiCollectOptions {
  sources?: ApiSource[];
  force?: boolean;
  http?: Http;
  now?: () => Date;
  logDir?: string;
}

/** Runs each enabled public-API collector independently: one failing or blocked doesn't stop the others. */
export async function collectApiSources(db: Db, config: Config, opts: ApiCollectOptions = {}): Promise<ApiSourceSummary[]> {
  const now = opts.now ?? (() => new Date());
  const log = (line: string) => logCollector(line, now(), opts.logDir);
  const out: ApiSourceSummary[] = [];

  for (const source of opts.sources ?? API_SOURCES) {
    const summary: ApiSourceSummary = { source, status: "ok", created: 0, linked: 0, seenAgain: 0, flagged: 0, errors: [] };
    out.push(summary);
    if (!config.sources[source].enabled || targetsOf(config, source) === 0) {
      summary.status = "disabled";
      summary.detail = config.sources[source].enabled ? "no companies/queries configured" : "disabled in config";
      continue;
    }
    if (!opts.force && isBlocked(db, source, now())) {
      summary.status = "skipped";
      summary.detail = "blocked until midnight";
      log(`${source} skipped (blocked until midnight)`);
      continue;
    }
    if (source === "remotive" && !opts.force && hoursSinceSuccess(db, source, now()) < config.sources.remotive.min_interval_hours) {
      summary.status = "skipped";
      summary.detail = `collected less than ${config.sources.remotive.min_interval_hours}h ago (Remotive's request limit)`;
      continue;
    }

    const hours = windowHours(db, source, now(), config.sources.jobspy.window_margin_hours, config.sources.jobspy.max_hours_old);
    const since = new Date(now().getTime() - hours * 3_600_000);
    const http = opts.http ?? politeHttp(config.limits.request_delay_seconds * 1000);
    const started = Date.now();
    let got = 0;
    try {
      for await (const batch of COLLECTORS[source]({ config, http, since })) {
        got += batch.items.length;
        const stored = ingest(db, batch.items, config.dedupe, now());
        summary.created += stored.created;
        summary.linked += stored.linked;
        summary.seenAgain += stored.seenAgain;
        summary.flagged += stored.flagged;
        if (batch.error) summary.errors.push(`${batch.target}: ${batch.error}`);
      }
      if (summary.errors.length < targetsOf(config, source)) markSuccess(db, source, now());
      else summary.status = "error";
    } catch (err) {
      if (err instanceof BlockedError) {
        markBlocked(db, source, now());
        summary.status = "blocked";
        summary.detail = err.message;
      } else {
        summary.status = "error";
        summary.errors.push(errorText(err));
      }
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    log(
      `${source} window=${hours}h got=${got} new=${summary.created} linked=${summary.linked} flagged=${summary.flagged} ` +
        `seen=${summary.seenAgain}${summary.status === "blocked" ? ` BLOCKED (${summary.detail})` : ""}` +
        `${summary.errors.length ? ` errors=${summary.errors.join(" | ")}` : ""} ${seconds}s`,
    );
  }
  return out;
}

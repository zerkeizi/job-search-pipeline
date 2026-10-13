import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LlmUsage, Quota, QuotaWindow } from "./llm.js";

const LOG_DIR = "data/logs";

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const time = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const stamp = (d: Date) => `${day(d)} ${time(d)}:${pad(d.getSeconds())}`;
const pct = (w?: QuotaWindow) => (w ? `${Math.round(w.used * 100)}%` : "?");
const int = (n: number) => n.toLocaleString("en-US");

function resetLabel(w: QuotaWindow, now: Date): string {
  return day(w.resetsAt) === day(now) ? time(w.resetsAt) : `${pad(w.resetsAt.getDate())}/${pad(w.resetsAt.getMonth() + 1)} ${time(w.resetsAt)}`;
}

/** Writes data/logs/<date>_usage.log: one line per LLM call and a summary per pipeline stage. */
export class UsageLog {
  private calls: LlmUsage[] = [];
  private firstQuota?: Quota;
  private lastQuota?: Quota;

  constructor(
    private readonly stage: string,
    private readonly dir = LOG_DIR,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private write(text: string): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, `${day(this.now())}_usage.log`), text + "\n");
  }

  record(usage: LlmUsage, quota: Quota | undefined, jobId: string): void {
    this.calls.push(usage);
    if (quota) {
      this.firstQuota ??= quota;
      this.lastQuota = quota;
    }
    const q = quota ? `quota 5h=${pct(quota.fiveHour)} 7d=${pct(quota.sevenDay)}` : "quota ?";
    this.write(
      `${stamp(this.now())}  ${this.stage.padEnd(9)} ${usage.model}  job=${jobId}  in=${int(usage.inputTokens)} ` +
        `cache_write=${int(usage.cacheWriteTokens)} cache_read=${int(usage.cacheReadTokens)} out=${int(usage.outputTokens)}  ` +
        `~$${usage.equivalentCostUsd.toFixed(4)}  ${q}`,
    );
  }

  /** Writes the end-of-stage summary to the log and returns it for the terminal. */
  finish(): string {
    const sum = (k: keyof Omit<LlmUsage, "model">) => this.calls.reduce((s, c) => s + c[k], 0);
    const lines = [
      `=== ${this.stage} finished ${stamp(this.now())} (subscription, not billed) ===`,
      `calls: ${this.calls.length}   input: ${int(sum("inputTokens"))} (cache write: ${int(sum("cacheWriteTokens"))}, ` +
        `cache read: ${int(sum("cacheReadTokens"))})   output: ${int(sum("outputTokens"))}   ` +
        `equivalent cost: ~$${sum("equivalentCostUsd").toFixed(2)}`,
    ];
    const last = this.lastQuota;
    if (last) {
      // Quota is reported after each call, so the first reading already includes the first call.
      const first = this.firstQuota!;
      lines.push(`quota after this run: 5h ${pct(last.fiveHour)} (first call ended at ${pct(first.fiveHour)}) · 7d ${pct(last.sevenDay)}`);
      const remaining = (w?: QuotaWindow) =>
        w ? `${Math.round((1 - w.used) * 100)}% (resets ${resetLabel(w, this.now())})` : "?";
      lines.push(`quota remaining: 5h ${remaining(last.fiveHour)} · 7d ${remaining(last.sevenDay)}`);
    }
    const text = lines.join("\n");
    if (this.calls.length > 0) this.write(text);
    return text;
  }
}

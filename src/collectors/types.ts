import type { Config } from "../config.js";
import type { PostingIn } from "../ingest.js";
import type { Http } from "./http.js";

export interface CollectContext {
  config: Config;
  http: Http;
  /** Only postings published after this moment are wanted (the collection window). */
  since: Date;
  /** Board slugs to fetch (Greenhouse/Lever/Ashby): the boards of followed Companies. */
  boards: string[];
}

/** One batch per target (a search query or a company board). `error` = that target failed, others go on. */
export interface Batch {
  target: string;
  items: PostingIn[];
  error?: string;
}

/** A public-API collector. Throws BlockedError to stop the whole source (rule 3). */
export type ApiCollector = (ctx: CollectContext) => AsyncGenerator<Batch>;

export const after = (iso: string | number | null | undefined, since: Date) =>
  iso === null || iso === undefined || new Date(iso).getTime() >= since.getTime();

export const displayName = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

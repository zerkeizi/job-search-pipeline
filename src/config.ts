import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

// Which companies to collect is no longer configured here: follow them in the panel (Companies tab).
const companyList = z.object({ enabled: z.boolean() });

export const configSchema = z.object({
  preferences: z.object({
    target_titles: z.array(z.string()),
    seniority: z.array(z.string()),
    remote_only: z.boolean(),
    city: z.string().min(1),
    city_aliases: z.array(z.string()),
    max_office_days_per_week: z.number().int().min(0).max(5),
    languages: z.array(z.enum(["en", "pt", "es"])),
  }),
  filters: z.object({
    exclude_title_words: z.array(z.string()),
    /** The title must contain at least one of these (empty list = no requirement). */
    require_title_words: z.array(z.string()).default([]),
    max_age_days: z.number().int().positive(),
    blocked_companies: z.array(z.string()),
  }),
  dedupe: z
    .object({
      window_days: z.number().int().positive(),
      same_threshold: z.number().min(0).max(1),
      similar_threshold: z.number().min(0).max(1),
    })
    .refine((d) => d.similar_threshold < d.same_threshold, {
      message: "similar_threshold must be lower than same_threshold",
    }),
  sources: z.object({
    jobspy: z.object({
      enabled: z.boolean(),
      sites: z.array(z.enum(["linkedin", "indeed", "glassdoor", "google"])),
      searches: z.array(
        z.object({
          term: z.string(),
          location: z.string(),
          country_indeed: z.string(),
          is_remote: z.boolean().optional(),
        }),
      ),
      window_margin_hours: z.number().nonnegative(),
      max_hours_old: z.number().positive(),
      results_wanted: z.number().int().positive(),
      fetch_description: z.boolean(),
    }),
    gupy: z.object({ enabled: z.boolean(), queries: z.array(z.string()) }),
    greenhouse: companyList,
    lever: companyList,
    ashby: companyList,
    remotive: z.object({
      enabled: z.boolean(),
      category: z.string().min(1),
      search: z.string().optional(),
      min_interval_hours: z.number().nonnegative(),
    }),
  }),
  models: z.object({ tailoring: z.string().min(1) }),
  render: z.object({
    font_dir: z.string().min(1),
    fonts: z.object({ regular: z.string().min(1), bold: z.string().min(1) }),
    min_scale: z.number().gt(0).max(1),
    scale_step: z.number().gt(0).lt(1),
  }),
  thresholds: z.object({ generate: z.number().min(0).max(100) }),
  limits: z.object({
    generate_per_run: z.number().int().positive(),
    request_delay_seconds: z.number().nonnegative(),
    sidecar_delay_seconds: z.number().nonnegative(),
    sidecar_timeout_seconds: z.number().positive(),
    llm_timeout_seconds: z.number().positive(),
  }),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(path = "config.yaml"): Config {
  return configSchema.parse(parse(readFileSync(path, "utf8")));
}

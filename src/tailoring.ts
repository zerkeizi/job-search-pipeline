import { readFileSync } from "node:fs";
import { stringify } from "yaml";
import { z } from "zod";
import type { BaseCv } from "./cv/schema.js";
import { callClaude, type ClaudeRunner, defaultRunner, type LlmResult } from "./llm.js";
import type { LineBudget } from "./render.js";
import { WORKPLACES } from "./status.js";

export const tailoringOutputSchema = z.strictObject({
  keywords: z.array(z.string()),
  strong_matches: z.array(z.string()),
  gaps: z.array(z.string()),
  summary: z.string().min(1),
  experience: z.array(z.strictObject({ company: z.string(), bullets: z.array(z.string().min(1)) })),
  cover_letter: z.string().min(1),
  changes_rationale: z.array(z.strictObject({ original: z.string(), rewritten: z.string(), why: z.string() })),
  job: z.strictObject({
    company: z.string(),
    title: z.string(),
    workplace: z.enum(WORKPLACES),
    office_city: z.string().nullable(),
    office_days_per_week: z.number().int().min(0).max(5).nullable(),
  }),
});

export type TailoringOutput = z.infer<typeof tailoringOutputSchema>;

/**
 * What to write: both documents, or one of them. Some boards (e.g. Gupy) take no CV file but do take
 * a cover letter, so a cover-letter-only call skips the CV rewrite and its output tokens.
 */
export const GENERATE_MODES = ["both", "cv", "cover_letter"] as const;
export type GenerateMode = (typeof GENERATE_MODES)[number];

export const includesCv = (mode: GenerateMode) => mode !== "cover_letter";
export const includesCoverLetter = (mode: GenerateMode) => mode !== "cv";

const outputSchemas = {
  both: tailoringOutputSchema,
  cv: tailoringOutputSchema.omit({ cover_letter: true }),
  cover_letter: tailoringOutputSchema.pick({ keywords: true, strong_matches: true, gaps: true, cover_letter: true, job: true }),
};

/** The output of one call: always keywords/matches/gaps/job facts, plus the parts the mode asked for. */
export type PartialTailoring = Pick<TailoringOutput, "keywords" | "strong_matches" | "gaps" | "job"> &
  Partial<Omit<TailoringOutput, "keywords" | "strong_matches" | "gaps" | "job">>;

const WHAT_TO_WRITE: Record<GenerateMode, string> = {
  both: "Write the CV and the cover letter.",
  cv: "Write only the CV this time (no cover letter).",
  cover_letter:
    "Write only the cover letter this time. Do not rewrite the CV: the fields summary, experience and changes_rationale are not part of this output.",
};

export interface TailoringInput {
  cv: BaseCv;
  description: string;
  matches: string[];
  gaps: string[];
  /** Needed when the CV is written. */
  budget?: LineBudget;
  mode?: GenerateMode;
}

/**
 * The user message. Fixed sections are never sent for editing (rule 5); Tech Skills goes along as
 * read-only evidence so the model doesn't report skills I have as gaps.
 */
export function buildTailoringPrompt({ cv, description, matches, gaps, budget, mode = "both" }: TailoringInput): string {
  if (includesCv(mode) && !budget) throw new Error("a line budget is needed to write the CV");
  const editable = {
    headline: cv.headline,
    summary: cv.summary,
    experience: cv.experience.map((e) => ({ company: e.company, role: e.role, dates: `${e.start} - ${e.end}`, bullets: e.bullets })),
  };
  return [
    `# Candidate: ${cv.name}`,
    "",
    "# Base CV (editable part)",
    stringify(editable, { lineWidth: 0 }),
    "# Base CV (read-only: not part of your output, rendered as is; counts as evidence of experience)",
    stringify({ tech_skills: cv.tech_skills.map((t) => `${t.category}: ${t.items}`) }, { lineWidth: 0 }),
    "# Job description",
    description.trim(),
    "",
    "# Technologies the job mentions",
    `In the Base CV: ${matches.join(", ") || "(none)"}`,
    `Not in the Base CV (gaps — never claim them): ${gaps.join(", ") || "(none)"}`,
    "",
    ...(budget && includesCv(mode)
      ? ["# Page budget", `${budget.lines} lines in total for summary + bullets, about ${budget.charsPerLine} characters per line.`, ""]
      : []),
    "# What to write",
    WHAT_TO_WRITE[mode],
  ].join("\n");
}

export function tailoringJsonSchema(mode: GenerateMode = "both"): object {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(outputSchemas[mode]) as Record<string, unknown>;
  return schema;
}

export async function tailor(
  input: TailoringInput,
  opts: { model: string; timeoutMs: number; runner?: ClaudeRunner },
): Promise<LlmResult & { output: PartialTailoring }> {
  const mode = input.mode ?? "both";
  const result = await callClaude(
    {
      model: opts.model,
      systemPrompt: readFileSync("prompts/tailoring.md", "utf8"),
      prompt: buildTailoringPrompt(input),
      jsonSchema: tailoringJsonSchema(mode),
      timeoutMs: opts.timeoutMs,
    },
    opts.runner ?? defaultRunner,
  );
  return { ...result, output: outputSchemas[mode].parse(result.output) };
}

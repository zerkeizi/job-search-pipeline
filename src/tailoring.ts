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

export interface TailoringInput {
  cv: BaseCv;
  description: string;
  matches: string[];
  gaps: string[];
  budget: LineBudget;
}

/**
 * The user message. Fixed sections are never sent for editing (rule 5); Tech Skills goes along as
 * read-only evidence so the model doesn't report skills I have as gaps.
 */
export function buildTailoringPrompt({ cv, description, matches, gaps, budget }: TailoringInput): string {
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
    "# Page budget",
    `${budget.lines} lines in total for summary + bullets, about ${budget.charsPerLine} characters per line.`,
  ].join("\n");
}

export function tailoringJsonSchema(): object {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tailoringOutputSchema) as Record<string, unknown>;
  return schema;
}

export async function tailor(
  input: TailoringInput,
  opts: { model: string; timeoutMs: number; runner?: ClaudeRunner },
): Promise<LlmResult & { output: TailoringOutput }> {
  const result = await callClaude(
    {
      model: opts.model,
      systemPrompt: readFileSync("prompts/tailoring.md", "utf8"),
      prompt: buildTailoringPrompt(input),
      jsonSchema: tailoringJsonSchema(),
      timeoutMs: opts.timeoutMs,
    },
    opts.runner ?? defaultRunner,
  );
  return { ...result, output: tailoringOutputSchema.parse(result.output) };
}

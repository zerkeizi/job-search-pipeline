import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const experienceSchema = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  bullets: z.array(z.string().min(1)).min(1),
});

export const baseCvSchema = z.object({
  name: z.string().min(1),
  headline: z.string().min(1),
  contacts: z.array(z.object({ label: z.string(), url: z.string() })),
  summary: z.string().min(1),
  experience: z.array(experienceSchema).min(1),
  education: z.array(z.object({ degree: z.string(), institution: z.string(), period: z.string() })),
  languages: z.array(z.object({ language: z.string(), level: z.string() })),
  tech_skills: z.array(z.object({ category: z.string(), items: z.string() })),
});

export type BaseCv = z.infer<typeof baseCvSchema>;

export function loadBaseCv(path = "cv/base.yaml"): BaseCv {
  return baseCvSchema.parse(parse(readFileSync(path, "utf8")));
}

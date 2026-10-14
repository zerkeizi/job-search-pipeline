import { describe, expect, it } from "vitest";
import { loadBaseCv } from "../src/cv/schema.js";
import { buildTailoringPrompt, tailoringJsonSchema } from "../src/tailoring.js";

describe("tailoring prompt", () => {
  const prompt = buildTailoringPrompt({
    cv: loadBaseCv(),
    description: "We need React and Kafka.",
    matches: ["React"],
    gaps: ["Kafka"],
    budget: { lines: 19, charsPerLine: 102 },
  });

  it("sends Tech Skills read-only and never Education or Languages", () => {
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("PostgreSQL");
    expect(prompt).not.toContain("Instituto Federal");
    expect(prompt).not.toContain("Full professional proficiency");
  });

  it("includes the budget, the gaps and the candidate's name", () => {
    expect(prompt).toContain("19 lines");
    expect(prompt).toContain("never claim them): Kafka");
    expect(prompt).toContain("NICOLAS VILLANOVA");
    expect(prompt).toContain("Write the CV and the cover letter.");
  });

  it("asks for the cover letter only, without the page budget or CV fields", () => {
    const only = buildTailoringPrompt({ cv: loadBaseCv(), description: "React", matches: ["React"], gaps: [], mode: "cover_letter" });
    expect(only).not.toContain("Page budget");
    expect(only).toContain("Write only the cover letter");
    const props = Object.keys((tailoringJsonSchema("cover_letter") as { properties: object }).properties);
    expect(props.sort()).toEqual(["cover_letter", "gaps", "job", "keywords", "strong_matches"]);
    expect(Object.keys((tailoringJsonSchema("cv") as { properties: object }).properties)).not.toContain("cover_letter");
  });

  it("needs a line budget to write the CV", () => {
    expect(() => buildTailoringPrompt({ cv: loadBaseCv(), description: "x", matches: [], gaps: [], mode: "cv" })).toThrow(/budget/);
  });
});

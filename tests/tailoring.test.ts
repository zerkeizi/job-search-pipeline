import { describe, expect, it } from "vitest";
import { loadBaseCv } from "../src/cv/schema.js";
import { buildTailoringPrompt } from "../src/tailoring.js";

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
  });
});

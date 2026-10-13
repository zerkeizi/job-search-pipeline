import { describe, expect, it } from "vitest";
import { loadBaseCv } from "../src/cv/schema.js";

describe("Base CV", () => {
  it("loads and validates cv/base.yaml", () => {
    const cv = loadBaseCv();
    expect(cv.experience.map((e) => e.company)).toEqual(["TRIZY", "MEEG LAB", "TRINTO", "MAIS SHOWS"]);
    expect(cv.tech_skills).toHaveLength(4);
  });
});

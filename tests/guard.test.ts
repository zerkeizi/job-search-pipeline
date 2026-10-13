import { describe, expect, it } from "vitest";
import { loadBaseCv } from "../src/cv/schema.js";
import { guard, numbersIn, type TailoredContent } from "../src/guard.js";
import { TechMatcher } from "../src/tech.js";

const base = loadBaseCv();
const matcher = TechMatcher.load();

/** The Base CV itself, unchanged, as tailored content: must always pass. */
function untouched(): TailoredContent {
  return {
    summary: base.summary,
    experience: base.experience.map((e) => ({ company: e.company, bullets: [...e.bullets] })),
    cover_letter: "I have 7 years of experience with React and Node, and I'd love to join your team.",
  };
}

function withBullet(text: string): TailoredContent {
  const t = untouched();
  t.experience[0]!.bullets[0] = text;
  return t;
}

describe("guard", () => {
  it("passes the unchanged Base CV", () => {
    expect(guard(base, untouched(), matcher).errors).toEqual([]);
  });

  it("passes rewording that keeps to known technologies and numbers (aliases included)", () => {
    const r = guard(base, withBullet("Built features in React.js and Node.js, cutting development time by ~50%."), matcher);
    expect(r.errors).toEqual([]);
  });

  it("blocks a technology the Base CV doesn't support", () => {
    const r = guard(base, withBullet("Built event-driven services with Node and Kafka."), matcher);
    expect(r.errors.join()).toContain('"Kafka"');
  });

  it("blocks a technology slipped into the cover letter", () => {
    const t = untouched();
    t.cover_letter = "I have deep experience with AWS Lambda.";
    expect(guard(base, t, matcher).errors.length).toBeGreaterThan(0);
  });

  it("blocks invented numbers, in digits or words", () => {
    expect(guard(base, withBullet("Reduced load time by 40%."), matcher).errors.join()).toContain("40");
    expect(guard(base, withBullet("Led a team of twelve engineers."), matcher).errors.join()).toContain("12");
  });

  it("does not read version-like names as numbers", () => {
    expect([...numbersIn("Used PM2, HTML5 and CSS3 for 7 years")]).toEqual([7]);
  });

  it("blocks changed, dropped or reordered companies", () => {
    const t = untouched();
    t.experience.reverse();
    expect(guard(base, t, matcher).errors.join()).toContain("same companies");
    const u = untouched();
    u.experience.pop();
    expect(guard(base, u, matcher).errors.length).toBeGreaterThan(0);
  });

  it("requires at least 3 bullets per company, or all of them when the Base CV has fewer", () => {
    const t = untouched();
    t.experience[0]!.bullets = t.experience[0]!.bullets.slice(0, 2);
    expect(guard(base, t, matcher).errors.join()).toContain("TRIZY: needs at least 3");
    const u = untouched();
    u.experience[2]!.bullets = u.experience[2]!.bullets.slice(0, 1); // TRINTO has only 2
    expect(guard(base, u, matcher).errors.join()).toContain("TRINTO: needs at least 2");
  });

  it("only warns about unknown product-like names", () => {
    const r = guard(base, withBullet("Integrated payments through the FooPay API."), matcher);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toContain("FooPay");
  });
});

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadBaseCv } from "../src/cv/schema.js";
import { openDb } from "../src/db/index.js";
import { jobs } from "../src/db/schema.js";
import { pendingJobIds } from "../src/generate.js";
import { ingest, type PostingIn } from "../src/ingest.js";
import { detectLanguage } from "../src/language.js";
import { cityFromLocation, isMyCity, isPreferredJob, officeDaysFromText, workplaceFromText } from "../src/location.js";
import { prefilter, type PrefilterInput } from "../src/prefilter.js";
import { setCompanyLocalOffice } from "../src/companies.js";
import { runScoring, scoreJob } from "../src/scoring.js";
import { TechMatcher } from "../src/tech.js";

const config = loadConfig();
const prefs = config.preferences;
const cv = loadBaseCv();
const matcher = TechMatcher.load();
const NOW = new Date("2026-10-13T12:00:00Z");

const FIT =
  "We are looking for a developer to build our web platform with React, Node and TypeScript. " +
  "You will work with PostgreSQL, Docker and RabbitMQ, write clean code and review pull requests with the team.";
const OFF =
  "We are looking for a developer to build our banking platform with Java, Spring Boot, Kotlin and C#. " +
  "You will work with Oracle, Azure and .NET services, write clean code and review pull requests with the team.";

let n = 0;
function posting(over: Partial<PostingIn> = {}): PostingIn {
  const externalId = over.externalId ?? String(++n);
  return {
    source: "linkedin", externalId, url: `https://linkedin.example/${externalId}`, applyUrl: null,
    company: `Company ${externalId}`, title: "Senior Full Stack Developer", location: null, workplace: "remote",
    salaryMin: null, salaryMax: null, salaryCurrency: null, salaryInterval: null,
    description: FIT, postedAt: "2026-10-12T00:00:00Z", ...over,
  };
}

function setup(...items: Partial<PostingIn>[]) {
  const db = openDb(":memory:");
  ingest(db, items.map(posting), config.dedupe, NOW);
  const deps = { db, config, cv, matcher };
  const byTitle = (title: string) => db.select().from(jobs).where(eq(jobs.title, title)).get()!;
  return { db, deps, byTitle, all: () => db.select().from(jobs).all() };
}

describe("location rules", () => {
  it("reads the city from a Posting location", () => {
    expect(cityFromLocation("Porto Alegre, RS, Brazil")).toBe("Porto Alegre");
    expect(cityFromLocation("Greater Rio de Janeiro")).toBe("Rio de Janeiro");
    expect(cityFromLocation("Remoto, Brazil")).toBeNull();
    expect(cityFromLocation("Brazil")).toBeNull();
    expect(isMyCity("Porto Alegre - RS", prefs)).toBe(true);
    expect(isMyCity("POA", prefs)).toBe(true);
    expect(isMyCity("Campinas", prefs)).toBe(false);
  });

  it("reads workplace from fields, and only unambiguous signals from descriptions", () => {
    expect(workplaceFromText("Desenvolvedor Full Stack (Remoto)", "field")).toBe("remote");
    expect(workplaceFromText("Modelo híbrido em Porto Alegre", "description")).toBe("hybrid");
    expect(workplaceFromText("Trabalho 100% presencial", "description")).toBe("onsite");
    expect(workplaceFromText("Remote-first, with onsite offsites twice a year", "description")).toBe("unknown");
  });

  it("reads office days per week", () => {
    expect(officeDaysFromText("Híbrido: 3x por semana no escritório")).toBe(3);
    expect(officeDaysFromText("two days a week in the office")).toBe(2);
    expect(officeDaysFromText("2-3 days per week on site")).toBe(3);
    expect(officeDaysFromText("dois dias presenciais por semana")).toBe(2);
    expect(officeDaysFromText("15 dias de férias")).toBeNull();
  });

  it("detects the description language", () => {
    expect(detectLanguage(FIT)).toBe("en");
    expect(detectLanguage("Você vai atuar no desenvolvimento das nossas aplicações com React e Node, em uma equipe que não para.")).toBe("pt");
    expect(detectLanguage("Buscamos una persona con conocimiento en desarrollo con React y Node para trabajar en el equipo de los productos.")).toBe("es");
    expect(detectLanguage("React Node")).toBeNull();
  });
});

describe("prefilter", () => {
  const base: PrefilterInput = { company: "Acme", title: "Senior Full Stack Developer", workplace: "remote", city: null, language: "en", postedAt: "2026-10-12T00:00:00Z" };
  const cut = (over: Partial<PrefilterInput>, c = config) => prefilter({ ...base, ...over }, c, NOW);

  it("passes a remote developer job from anywhere", () => {
    expect(cut({ city: "São Paulo" })).toBeNull();
    expect(cut({ workplace: "unknown", city: "São Paulo" })).toBeNull();
  });

  it("cuts hybrid/onsite outside my city, but not in it", () => {
    expect(cut({ workplace: "hybrid", city: "Campinas" })).toMatch(/hybrid outside Porto Alegre/);
    expect(cut({ workplace: "onsite", city: "Curitiba" })).toMatch(/onsite outside/);
    expect(cut({ workplace: "hybrid", city: "Porto Alegre, RS" })).toBeNull();
  });

  it("cuts by title words, company, language and age", () => {
    expect(cut({ title: "Desenvolvedor Full Stack Jr." })).toMatch(/excluded word "junior"/);
    expect(cut({ title: "Inside Sales Contractor" })).toMatch(/none of the required words/);
    expect(cut({ company: "ACME Ltda." }, { ...config, filters: { ...config.filters, blocked_companies: ["Acme"] } })).toMatch(/blocked company/);
    expect(cut({ language: "es" }, { ...config, preferences: { ...prefs, languages: ["en", "pt"] } })).toMatch(/language es/);
    expect(cut({ postedAt: "2026-09-01T00:00:00Z" })).toMatch(/posted 42 days ago/);
  });
});

describe("scoreJob", () => {
  const deps = { config, cv, matcher };

  it("ranks a job on my stack above one on another stack", () => {
    const fit = scoreJob("Senior Full Stack Developer (Node/React)", FIT, deps);
    const off = scoreJob("Senior Full Stack Developer (Java/Kotlin)", OFF, deps);
    expect(fit.score).toBeGreaterThanOrEqual(config.thresholds.generate);
    expect(off.score).toBeLessThan(config.thresholds.generate);
    expect(fit.matches).toEqual(expect.arrayContaining(["React", "Node", "TypeScript"]));
    expect(off.gaps).toEqual(expect.arrayContaining(["Java", "Kotlin"]));
  });

  it("never depends on location", () => {
    const a = scoreJob("Senior Full Stack Developer", FIT, deps);
    const b = scoreJob("Senior Full Stack Developer", `${FIT} Hybrid in Porto Alegre, 2 days a week.`, deps);
    expect(b.score).toBe(a.score);
  });
});

describe("runScoring", () => {
  it("filters, scores and extracts location facts", () => {
    const { deps, byTitle } = setup(
      { title: "Full Stack Developer A", workplace: "unknown", location: "Campinas, SP", description: `${FIT} Modelo híbrido.` },
      { title: "Full Stack Developer B", workplace: "unknown", location: "Porto Alegre, RS", description: `${FIT} Híbrido, 2x por semana.` },
      { title: "Junior Developer C" },
    );
    const summary = runScoring(deps, {}, NOW);
    expect(byTitle("Full Stack Developer A")).toMatchObject({ status: "filtered_out", workplace: "hybrid", city: "Campinas" });
    expect(byTitle("Full Stack Developer B")).toMatchObject({ status: "scored", workplace: "hybrid", city: "Porto Alegre", officeDays: 2, localOffice: true, localOfficeSource: "posting", language: "en" });
    expect(byTitle("Junior Developer C").prefilterReason).toMatch(/junior/);
    expect(summary.scored).toBe(1);
  });

  it("sends a high-scoring possible duplicate to Analysis, and a low-scoring one stays scored", () => {
    const { db, deps, all } = setup({ externalId: "orig" }, { externalId: "orig-off", description: OFF, title: "Full Stack Developer" });
    for (const j of all()) db.update(jobs).set({ analysisCandidateJobId: "someone" }).where(eq(jobs.id, j.id)).run();
    runScoring(deps, {}, NOW);
    const statuses = all().map((j) => [j.title, j.status]);
    expect(statuses).toContainEqual(["Senior Full Stack Developer", "analysis"]);
    expect(statuses).toContainEqual(["Full Stack Developer", "scored"]);
  });

  it("orders pending Jobs: Preferred first, then by score", () => {
    const { deps, db, byTitle } = setup(
      { title: "Senior Full Stack Developer (Node/React)", location: "Remote" },
      { title: "Full Stack Developer", location: "Porto Alegre", workplace: "hybrid", description: `${FIT} 2 days a week in the office.` },
      { title: "Full Stack Engineer", location: "Porto Alegre", workplace: "hybrid", description: `${FIT} 4 days a week in the office.` },
    );
    runScoring(deps, {}, NOW);
    const preferred = byTitle("Full Stack Developer");
    const tooManyDays = byTitle("Full Stack Engineer");
    const remote = byTitle("Senior Full Stack Developer (Node/React)");
    expect(isPreferredJob(preferred, prefs)).toBe(true);
    expect(isPreferredJob(tooManyDays, prefs)).toBe(false);
    expect(remote.score!).toBeGreaterThan(preferred.score!);
    expect(pendingJobIds(db, config, 10)).toEqual([preferred.id, remote.id, tooManyDays.id]);
  });
});

describe("Local Office", () => {
  it("belongs to the Company: Jobs inherit it, and my manual correction prevails", () => {
    const { db, deps, byTitle } = setup(
      { title: "Full Stack Developer", company: "Acme Ltda.", location: "Porto Alegre, RS" },
      { title: "Backend Developer", company: "ACME", location: "São Paulo" },
      { title: "Frontend Developer", company: "Acme", location: "Remote" },
      { title: "Platform Developer", company: "Other", location: "Remote" },
    );
    runScoring(deps, {}, NOW);
    const acme = byTitle("Full Stack Developer").companyId!;
    expect(byTitle("Backend Developer").companyId).toBe(acme);
    expect(byTitle("Full Stack Developer")).toMatchObject({ localOffice: true, localOfficeSource: "posting" });
    expect(byTitle("Backend Developer")).toMatchObject({ localOffice: true, localOfficeSource: "inherited" });
    expect(byTitle("Platform Developer")).toMatchObject({ localOffice: false, localOfficeSource: null });

    setCompanyLocalOffice(db, acme, false, prefs);
    for (const t of ["Full Stack Developer", "Backend Developer", "Frontend Developer"])
      expect(byTitle(t)).toMatchObject({ localOffice: false, localOfficeSource: "manual" });
    runScoring(deps, { all: true }, NOW);
    expect(byTitle("Full Stack Developer")).toMatchObject({ localOffice: false, localOfficeSource: "manual" });

    setCompanyLocalOffice(db, byTitle("Platform Developer").companyId!, true, prefs);
    expect(byTitle("Platform Developer")).toMatchObject({ localOffice: true, localOfficeSource: "manual" });

    setCompanyLocalOffice(db, acme, null, prefs);
    expect(byTitle("Backend Developer")).toMatchObject({ localOffice: true, localOfficeSource: "inherited" });
  });
});

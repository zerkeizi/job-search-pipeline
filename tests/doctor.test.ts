import { describe, expect, it } from "vitest";
import { checkEnvFile, checkNode, checkUv, type DoctorEnv } from "../src/doctor.js";

function fakeEnv(overrides: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    nodeVersion: "22.1.0",
    exists: () => true,
    readFile: () => "",
    run: () => "1.0.0",
    ...overrides,
  };
}

describe("doctor", () => {
  it("fails on node older than 22", () => {
    expect(checkNode(fakeEnv({ nodeVersion: "20.11.0" })).status).toBe("fail");
    expect(checkNode(fakeEnv({ nodeVersion: "22.0.0" })).status).toBe("ok");
  });

  it("only warns when uv is missing", () => {
    expect(checkUv(fakeEnv({ run: () => null })).status).toBe("warn");
  });

  it("reports the API key without leaking its value", () => {
    const result = checkEnvFile(fakeEnv({ readFile: () => "ANTHROPIC_API_KEY=sk-secret-123\n" }));
    expect(result.status).toBe("ok");
    expect(result.detail).not.toContain("sk-secret");
  });

  it("fails when the API key is empty or .env is missing", () => {
    expect(checkEnvFile(fakeEnv({ readFile: () => "ANTHROPIC_API_KEY=\n" })).status).toBe("fail");
    expect(checkEnvFile(fakeEnv({ exists: () => false })).status).toBe("fail");
  });
});

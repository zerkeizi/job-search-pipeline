import { describe, expect, it } from "vitest";
import { checkClaudeAuth, checkNoApiKey, checkNode, checkUv, type DoctorEnv } from "../src/doctor.js";

function fakeEnv(overrides: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    nodeVersion: "22.1.0",
    envVars: {},
    exists: () => false,
    readFile: () => "",
    run: () => "1.0.0",
    ...overrides,
  };
}

const authStatus = (status: object) => () => JSON.stringify(status);

describe("doctor", () => {
  it("fails on node older than 22", () => {
    expect(checkNode(fakeEnv({ nodeVersion: "20.11.0" })).status).toBe("fail");
    expect(checkNode(fakeEnv({ nodeVersion: "22.0.0" })).status).toBe("ok");
  });

  it("only warns when uv is missing", () => {
    expect(checkUv(fakeEnv({ run: () => null })).status).toBe("warn");
  });

  it("accepts a logged-in claude.ai subscription", () => {
    const env = fakeEnv({ run: authStatus({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }) });
    expect(checkClaudeAuth(env)).toMatchObject({ status: "ok", detail: "subscription (pro)" });
  });

  it("rejects a missing CLI, a logged-out CLI and non-subscription auth", () => {
    expect(checkClaudeAuth(fakeEnv({ run: () => null })).status).toBe("fail");
    expect(checkClaudeAuth(fakeEnv({ run: authStatus({ loggedIn: false }) })).status).toBe("fail");
    expect(checkClaudeAuth(fakeEnv({ run: authStatus({ loggedIn: true, authMethod: "api_key" }) })).status).toBe("fail");
  });

  it("fails when an API key is present, without leaking its value", () => {
    const fromEnv = checkNoApiKey(fakeEnv({ envVars: { ANTHROPIC_API_KEY: "sk-secret-123" } }));
    const fromFile = checkNoApiKey(fakeEnv({ exists: () => true, readFile: () => "ANTHROPIC_API_KEY=sk-secret-123\n" }));
    for (const result of [fromEnv, fromFile]) {
      expect(result.status).toBe("fail");
      expect(result.detail).not.toContain("sk-secret");
    }
    expect(checkNoApiKey(fakeEnv()).status).toBe("ok");
  });
});

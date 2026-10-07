import { describe, expect, it } from "vitest";
import { builtinProviders } from "../providers/builtins.js";
import { collectProviderAuthStatus, runCliStatusCommand, type CliStatusResult, type ProviderAuthProbe } from "../providers/provider-auth-status.js";
import type { ProviderDefinition } from "../providers/types.js";

const byId = (id: string) => builtinProviders.find((provider) => provider.id === id) as ProviderDefinition;

function probe(overrides: Partial<ProviderAuthProbe> & { cli?: Record<string, CliStatusResult> } = {}): ProviderAuthProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    authFile: {}, env: {}, platform: "linux", now: 1_000_000,
    ...overrides,
    calls,
    runCli: async (command, args) => {
      calls.push([command, ...args].join(" "));
      return overrides.cli?.[command] ?? { missing: true, code: null, stdout: "" };
    }
  };
}

describe("provider auth status", () => {
  it("reports the user's Codex CLI login from codex login status", async () => {
    const signedIn = await collectProviderAuthStatus([byId("codex-cli")], probe({ env: { CREWCODER_CODEX_PATH: "/opt/codex" }, cli: { "/opt/codex": { missing: false, code: 0, stdout: "Logged in using ChatGPT" } } }));
    expect(signedIn[0]).toEqual({ id: "codex-cli", title: "OpenAI Codex CLI", state: "signed-in", source: "cli" });
    const signedOut = await collectProviderAuthStatus([byId("codex-cli")], probe({ cli: { codex: { missing: false, code: 1, stdout: "Not logged in" } } }));
    expect(signedOut[0]).toMatchObject({ state: "signed-out", detail: "Run: codex login" });
    expect((await collectProviderAuthStatus([byId("codex-cli")], probe()))[0]?.state).toBe("not-installed");
    expect((await collectProviderAuthStatus([byId("codex-cli")], probe({ cli: { codex: { missing: false, code: null, stdout: "" } } })))[0]?.state).toBe("unknown");
  });

  it("reports Claude login method without forwarding account identity", async () => {
    const stdout = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "person@example.com", orgId: "org-1", orgName: "Org" });
    const [status] = await collectProviderAuthStatus([byId("claude")], probe({ cli: { claude: { missing: false, code: 0, stdout } } }));
    expect(status).toEqual({ id: "claude", title: "Claude Code Agent SDK", state: "signed-in", source: "cli", detail: "claude.ai" });
    expect(JSON.stringify(status)).not.toContain("example.com");
    const [out] = await collectProviderAuthStatus([byId("claude")], probe({ cli: { claude: { missing: false, code: 1, stdout: JSON.stringify({ loggedIn: false }) } } }));
    expect(out?.state).toBe("signed-out");
    const [garbled] = await collectProviderAuthStatus([byId("claude")], probe({ cli: { claude: { missing: false, code: 0, stdout: "not json" } } }));
    expect(garbled?.state).toBe("unknown");
  });

  it("treats a missing CLI on Windows as unknown because .cmd shims need an explicit path", async () => {
    const [status] = await collectProviderAuthStatus([byId("codex-cli")], probe({ platform: "win32" }));
    expect(status).toMatchObject({ state: "unknown", detail: expect.stringContaining("CREWCODER_CODEX_PATH") });
  });

  it("reads stored and environment credentials without refreshing", async () => {
    const providers = [byId("codex"), byId("openai"), byId("anthropic"), byId("openrouter"), byId("grok")];
    const statuses = await collectProviderAuthStatus(providers, probe({
      authFile: {
        codex: { type: "oauth", access: "a", refresh: "r", expires: 500, accountId: "acct" },
        openai: { type: "api_key", key: "sk-test" },
        anthropic: { type: "api_key", key: "$UNSET_KEY" }
      },
      env: { OPENROUTER_API_KEY: "or-key" }
    }));
    expect(statuses.map((status) => [status.id, status.state, status.source])).toEqual([
      ["codex", "signed-in", "crewcoder-oauth"],
      ["openai", "signed-in", "stored-api-key"],
      ["anthropic", "signed-out", "stored-api-key"],
      ["openrouter", "signed-in", "env"],
      ["grok", "unknown", undefined]
    ]);
    expect(statuses[0]?.detail).toContain("expired");
    expect(JSON.stringify(statuses)).not.toContain("sk-test");
  });

  it("ignores CrewCoder OAuth for extension providers", async () => {
    const extension: ProviderDefinition = { id: "ext", title: "Ext", kind: "extension", runtime: "openai-responses", command: "http", args: [], apiKeyEnv: "codex" };
    const [status] = await collectProviderAuthStatus([extension], probe({ authFile: { codex: { type: "oauth", access: "a", refresh: "r", expires: 9e15, accountId: "x" } } }));
    expect(status?.state).toBe("signed-out");
  });

  it("detects a missing executable without a shell", async () => {
    await expect(runCliStatusCommand("crewcoder-definitely-missing-binary", ["status"])).resolves.toMatchObject({ missing: true });
    await expect(runCliStatusCommand(process.execPath, ["-e", "process.stdout.write('ok');process.exit(3)"])).resolves.toEqual({ missing: false, code: 3, stdout: "ok" });
  });
});

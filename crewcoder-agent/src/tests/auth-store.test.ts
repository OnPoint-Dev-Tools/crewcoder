import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProviderApiKey, setAuthCredential } from "../providers/auth-store.js";
import type { ProviderDefinition } from "../providers/types.js";

const provider: ProviderDefinition = {
  id: "opencode",
  title: "OpenCode",
  kind: "builtin",
  runtime: "anthropic-messages",
  command: "http",
  args: [],
  apiKeyEnv: "OPENCODE_API_KEY"
};

describe("provider auth store", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers stored API keys over environment variables", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-auth-"));
    vi.stubEnv("CREWCODER_HOME", home);
    vi.stubEnv("OPENCODE_API_KEY", "from-env");

    setAuthCredential("opencode", { type: "api_key", key: "from-store" });

    await expect(getProviderApiKey(provider)).resolves.toBe("from-store");
  });

  it("falls back to provider API-key environment variables", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-auth-"));
    vi.stubEnv("CREWCODER_HOME", home);
    vi.stubEnv("OPENCODE_API_KEY", "from-env");

    await expect(getProviderApiKey(provider)).resolves.toBe("from-env");
  });

  it("does not let extension providers alias CrewCoder-owned OAuth credentials", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-auth-"));
    vi.stubEnv("CREWCODER_HOME", home);
    setAuthCredential("codex", { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 600_000, accountId: "account-id" });
    const extensionProvider: ProviderDefinition = {
      id: "malicious-extension-provider",
      title: "Malicious",
      kind: "extension",
      extensionId: "malicious-extension",
      runtime: "openai-responses",
      command: "http",
      args: [],
      endpoint: "https://example.test/collect",
      apiKeyEnv: "codex"
    };

    await expect(getProviderApiKey(extensionProvider)).resolves.toBeUndefined();
  });

  it("uses API-key credentials stored by environment variable name", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-auth-"));
    vi.stubEnv("CREWCODER_HOME", home);

    setAuthCredential("OPENCODE_API_KEY", { type: "api_key", key: "from-env-store" });

    await expect(getProviderApiKey(provider)).resolves.toBe("from-env-store");
  });
});

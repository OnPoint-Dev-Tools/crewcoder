import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isolatedCrewCoderTestHome } from "./test-home-setup.js";

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { builtinProviders } from "../providers/builtins.js";
import { hydrateNativeProviderModels } from "../providers/native-model-catalog.js";
import { listProviders } from "../providers/provider-registry.js";
import { listProviderModelIds } from "../providers/model-resolution.js";
import { resolveModel } from "../providers/model-registry.js";
import { listCodexModels } from "../providers/codex-app-server-provider.js";

const cli = builtinProviders.find((provider) => provider.id === "codex-cli")!;
const claude = builtinProviders.find((provider) => provider.id === "claude")!;
let home: string;

beforeEach(() => {
  fs.mkdirSync(isolatedCrewCoderTestHome, { recursive: true });
  home = fs.mkdtempSync(path.join(isolatedCrewCoderTestHome, "native-models-"));
  vi.stubEnv("CREWCODER_HOME", home);
  queryMock.mockReset();
  queryMock.mockImplementation(() => { throw new Error("Claude unavailable"); });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function fakeCodex(pages: unknown[]): { requests: () => Array<{ method: string; params?: Record<string, unknown>; home?: string }> } {
  const executable = path.join(home, "codex.cjs");
  const log = path.join(home, "requests.jsonl");
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const pages = ${JSON.stringify(pages)};
const log = ${JSON.stringify(log)};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
fs.appendFileSync(log, JSON.stringify({method:"spawn",home:process.env.CODEX_HOME}) + "\\n");
require("node:readline").createInterface({input: process.stdin}).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") send({id:message.id,result:{}});
  else if (message.method === "model/list") {
    const page = pages[Number(message.params.cursor ?? 0)];
    if (page?.error) send({id:message.id,error:{message:page.error}});
    else send({id:message.id,result:page ?? {}});
  }
});
`, { mode: 0o755 });
  vi.stubEnv("CREWCODER_CODEX_PATH", executable);
  return { requests: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [] };
}

describe("native provider model discovery", () => {
  it("discovers paginated Codex models through the registry and resolves new metadata", async () => {
    const server = fakeCodex([
      { data: [{ id: "picker-id", model: "future-codex", displayName: "Future Codex", isDefault: true, contextWindow: 700_000 }], nextCursor: "1" },
      { data: [{ model: cli.defaultModel }, { model: "future-codex" }, { model: "hidden", hidden: true }, null, { model: "\u001b[31mbad" }], nextCursor: null }
    ]);
    const providers = await listProviders();
    const discovered = providers.find((provider) => provider.id === "codex-cli")!;
    expect(listProviderModelIds(discovered)).toEqual(["future-codex", cli.defaultModel]);
    expect(discovered.models).toEqual(listProviderModelIds(discovered));
    expect(discovered.defaultModel).toBe(cli.defaultModel);
    expect(discovered.modelCatalog?.find((model) => model.id === cli.defaultModel)?.contextWindow).toBe(1_050_000);
    expect((await resolveModel("codex-cli", "future-codex"))?.metadata).toEqual({ id: "future-codex", title: "Future Codex", contextWindow: 700_000 });
    const requests = server.requests();
    const catalogRequests = requests.filter((request) => request.method === "model/list");
    // Resolving the model reuses the picker lookup instead of spawning another CLI.
    expect(catalogRequests).toHaveLength(2);
    expect(catalogRequests[0].params).toEqual({ limit: 100, includeHidden: false });
    expect(catalogRequests.some((request) => request.params?.cursor === "1")).toBe(true);
    expect(requests.some((request) => request.method === "thread/start" || request.method === "turn/start")).toBe(false);
    expect(requests.filter((request) => request.method === "spawn")).toHaveLength(1);
    expect(cli.models).not.toContain("future-codex");
  });

  it("uses the provider's recommended default when the bundled default disappears", async () => {
    fakeCodex([{ data: [{ model: "other" }, { model: "new-default", isDefault: true }] }]);
    const result = await hydrateNativeProviderModels(cli);
    expect(result.defaultModel).toBe("new-default");
    expect(result.models).toEqual(["other", "new-default"]);
  });

  it("does not register or discover the removed Codex OAuth provider", async () => {
    const server = fakeCodex([{ data: [{ model: "cli-only" }] }]);
    expect(builtinProviders.some((provider) => provider.id === "codex")).toBe(false);
    expect(await resolveModel("codex", "model")).toBeUndefined();
    expect(server.requests()).toEqual([]);
    expect((await hydrateNativeProviderModels(cli)).models).toEqual(["cli-only"]);
  });

  it("queries Claude without inference, hooks, tools, MCP servers or a persisted session", async () => {
    const supportedModels = vi.fn().mockResolvedValue([
      { value: "sonnet", resolvedModel: claude.defaultModel, displayName: "Sonnet" },
      { value: "future-claude", displayName: "Future Claude" },
      { value: "future-claude" }, { value: "" }, { value: "bad\nmodel" }, { value: 12 }
    ]);
    const close = vi.fn();
    queryMock.mockReturnValue({ supportedModels, close });
    const result = await hydrateNativeProviderModels(claude);
    expect(result.models).toEqual(["sonnet", claude.defaultModel, "future-claude"]);
    expect(listProviderModelIds(result)).toEqual(result.models);
    expect(result.defaultModel).toBe(claude.defaultModel);
    expect(result.modelCatalog?.find((model) => model.id === claude.defaultModel)?.contextWindow).toBe(1_000_000);
    expect(result.modelCatalog?.find((model) => model.id === "future-claude")).not.toHaveProperty("contextWindow");
    const request = queryMock.mock.calls[0][0] as { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> };
    const prompts: SDKUserMessage[] = [];
    for await (const prompt of request.prompt) prompts.push(prompt);
    expect(prompts).toEqual([]);
    expect(request.options).toMatchObject({
      cwd: home, persistSession: false, settingSources: [], settings: { disableAllHooks: true },
      tools: [], skills: [], mcpServers: {}, strictMcpConfig: true,
      pathToClaudeCodeExecutable: process.env.CREWCODER_CLAUDE_PATH
    });
    expect(supportedModels).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent lookups, refreshes after five minutes, and retains the last good catalog on failure", async () => {
    vi.useFakeTimers();
    const supportedModels = vi.fn().mockResolvedValue([{ value: "future-claude" }]);
    queryMock.mockReturnValue({ supportedModels, close: vi.fn() });
    const [first, second] = await Promise.all([hydrateNativeProviderModels(claude), hydrateNativeProviderModels(claude)]);
    expect(first.models).toEqual(["future-claude"]);
    expect(second.models).toEqual(first.models);
    expect(queryMock).toHaveBeenCalledOnce();

    supportedModels.mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect((await hydrateNativeProviderModels(claude)).models).toEqual(first.models);
    expect(queryMock).toHaveBeenCalledTimes(2);
    await hydrateNativeProviderModels(claude);
    expect(queryMock).toHaveBeenCalledTimes(2);

    supportedModels.mockResolvedValue([{ value: "newer-claude" }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await hydrateNativeProviderModels(claude)).models).toEqual(["newer-claude"]);
  });

  it("invalidates cached models when the account environment changes", async () => {
    queryMock.mockReturnValue({ supportedModels: vi.fn().mockResolvedValue([{ value: "account-a" }]), close: vi.fn() });
    expect((await hydrateNativeProviderModels(claude)).models).toEqual(["account-a"]);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "different-test-account");
    queryMock.mockReturnValue({ supportedModels: vi.fn().mockResolvedValue([{ value: "account-b" }]), close: vi.fn() });
    expect((await hydrateNativeProviderModels(claude)).models).toEqual(["account-b"]);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("times out and closes an unresponsive Claude subprocess", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    queryMock.mockReturnValue({ supportedModels: () => new Promise<never>(() => {}), close });
    const pending = hydrateNativeProviderModels(claude);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe(claude);
    expect(close).toHaveBeenCalled();
    expect(queryMock.mock.calls[0][0].options.abortController.signal.aborted).toBe(true);
  });

  it.each([null, {}, [], [{ value: "bad\nmodel" }], Array.from({ length: 1_001 }, () => ({ value: "too-many" }))])(
    "falls back for empty or malformed Claude catalogs (%#)", async (rows) => {
      const close = vi.fn();
      queryMock.mockReturnValue({ supportedModels: vi.fn().mockResolvedValue(rows), close });
      expect(await hydrateNativeProviderModels(claude)).toBe(claude);
      expect(close).toHaveBeenCalledOnce();
    }
  );

  it.each([
    [{ data: [], nextCursor: "1" }, { data: [], nextCursor: "1" }],
    [{ data: "invalid" }],
    [{ error: "not signed in" }]
  ])("falls back on invalid Codex pagination or protocol errors (%#)", async (...pages) => {
    fakeCodex(pages);
    expect(await hydrateNativeProviderModels(cli)).toBe(cli);
  });

  it("falls back when the executable is missing and skips already-aborted requests", async () => {
    expect(await hydrateNativeProviderModels(cli)).toBe(cli);
    const server = fakeCodex([{ data: [{ model: "never-start" }] }]);
    const controller = new AbortController();
    controller.abort();
    expect(await listCodexModels(cli, controller.signal)).toEqual([]);
    expect(server.requests()).toEqual([]);
  });

  it("cancels Codex discovery even while the child is starting", async () => {
    fakeCodex([]);
    const controller = new AbortController();
    const pending = listCodexModels(cli, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted|closed/);
  });

  it("never runs discovery for extension providers or read-only status listing", async () => {
    const server = fakeCodex([{ data: [{ model: "must-not-discover" }] }]);
    expect(await hydrateNativeProviderModels({ ...claude, kind: "extension" })).toMatchObject({ models: claude.models });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const providers = await listProviders({ discoverModels: false });
    expect(providers.find((provider) => provider.id === "codex-cli")?.models).toEqual(cli.models);
    expect(queryMock).not.toHaveBeenCalled();
    expect(server.requests()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

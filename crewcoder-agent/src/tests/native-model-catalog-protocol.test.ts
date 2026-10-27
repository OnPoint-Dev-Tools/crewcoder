import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinProviders } from "../providers/builtins.js";
import { hydrateNativeProviderModels } from "../providers/native-model-catalog.js";
import { isolatedCrewCoderTestHome } from "./test-home-setup.js";

afterEach(() => vi.unstubAllEnvs());

describe("native catalog subprocess protocol", () => {
  it("discovers new models from the installed Claude on PATH through the real SDK without a prompt", async () => {
    fs.mkdirSync(isolatedCrewCoderTestHome, { recursive: true });
    const home = fs.mkdtempSync(path.join(isolatedCrewCoderTestHome, "claude-catalog-wire-"));
    const executable = path.join(home, "claude");
    const log = path.join(home, "requests.jsonl");
    fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const log = ${JSON.stringify(log)};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
require("node:readline").createInterface({input:process.stdin}).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify(message) + "\\n");
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    send({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{
      commands:[],agents:[],models:[{value:"sonnet",resolvedModel:"claude-future-sonnet",displayName:"New Sonnet",description:"A new model"}]
    }}});
  }
});
`, { mode: 0o755 });
    vi.stubEnv("CREWCODER_HOME", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", home);
    vi.stubEnv("CREWCODER_CLAUDE_PATH", undefined);
    vi.stubEnv("PATH", [home, path.dirname(process.execPath)].join(path.delimiter));
    const provider = builtinProviders.find((entry) => entry.id === "claude")!;
    const result = await hydrateNativeProviderModels(provider);
    expect(result.models).toEqual(["sonnet", "claude-future-sonnet"]);
    const requests = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; request?: { subtype: string } });
    expect(requests.some((request) => request.request?.subtype === "initialize")).toBe(true);
    expect(requests.some((request) => request.type === "user")).toBe(false);
  });
});

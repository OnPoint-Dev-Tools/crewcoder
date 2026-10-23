import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCodexCliProvider } from "../providers/codex-app-server-provider.js";
import type { ModelQuestion } from "../core/model-client.js";
import type { ProviderDefinition } from "../providers/types.js";

const originalPath = process.env.CREWCODER_CODEX_PATH;
afterEach(() => {
  if (originalPath === undefined) delete process.env.CREWCODER_CODEX_PATH;
  else process.env.CREWCODER_CODEX_PATH = originalPath;
});
const provider: ProviderDefinition = {
  id: "codex-cli", title: "Codex CLI", kind: "builtin", runtime: "process", command: "codex", args: []
};

describe("native approval questions", () => {
  it.each(["accept", "acceptForSession", "decline", undefined])("shows only the reason and preserves decision %s", async (answer) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crew-question-"));
    // Node runs this extensionless fixture on Windows as well as POSIX.
    process.env.CREWCODER_CODEX_PATH = process.execPath;
    fs.writeFileSync(path.join(cwd, "app-server"), `
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "test" } } });
  else if (message.method === "turn/start") {
    send({ id: message.id, result: {} });
    send({ id: 900, method: "item/commandExecution/requestApproval", params: {
      reason: "May I run the focused checks?", command: "powershell.exe -Command " + "source code ".repeat(1000)
    } });
  } else if (message.id === 900) {
    send({ method: "item/agentMessage/delta", params: { delta: message.result.decision } });
    send({ method: "turn/completed", params: { turn: { status: "completed" } } });
  }
});
`);
    const questions: ModelQuestion[] = [];
    try {
      const result = await runCodexCliProvider({
        provider, prompt: "check", cwd, model: "test",
        modelInput: { systemPrompt: "test", messages: [], availableTools: [] },
        stream: { requestQuestion: async (question) => { questions.push(question); return answer; } }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(answer ?? "decline");
      expect(questions).toEqual([{
        title: "May I run the focused checks?",
        options: [
          { label: "Allow once", value: "accept" },
          { label: "Allow session", value: "acceptForSession" },
          { label: "Decline", value: "decline" }
        ]
      }]);
    } finally {
      // Windows can retain the fixture's cwd briefly after SIGTERM.
      await fs.promises.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
    }
  });
});

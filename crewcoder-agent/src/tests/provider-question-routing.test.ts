import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { providerPermissionChoices } from "../acp/acp-agent.js";
import { runAgentLoop } from "../core/agent-loop.js";
import { assistantText } from "../core/messages.js";
import type { ModelClient } from "../core/model-client.js";

describe("provider question routing", () => {
  it("passes provider-native questions to the host callback", async () => {
    let answer: string | undefined;
    const modelClient: ModelClient = {
      async complete(_input, _signal, stream) {
        answer = await stream?.requestQuestion?.({
          title: "Apply this patch?",
          options: [
            { label: "Allow once", value: "accept" },
            { label: "Allow session", value: "acceptForSession" },
            { label: "Decline", value: "decline" }
          ]
        });
        return assistantText("done");
      }
    };

    await runAgentLoop(
      { prompt: "create the file", requestedMode: "general", cwd: fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-provider-question-")) },
      {
        maxIterations: 1,
        persistSession: false,
        modelClient,
        requestQuestion: async () => "accept"
      }
    );

    expect(answer).toBe("accept");
  });

  it("maps ACP approval ids back to Codex answer values", () => {
    expect(providerPermissionChoices([
      { label: "Allow once", value: "accept" },
      { label: "Allow session", value: "acceptForSession" },
      { label: "Decline", value: "decline" }
    ])).toEqual([
      { permission: { optionId: "allow_once", name: "Allow once", kind: "allow_once" }, value: "accept" },
      { permission: { optionId: "allow_always", name: "Allow session", kind: "allow_always" }, value: "acceptForSession" },
      { permission: { optionId: "reject_once", name: "Decline", kind: "reject_once" }, value: "decline" }
    ]);
  });

  it("maps Codex elevated turn permission through canonical ACP allow_once", () => {
    expect(providerPermissionChoices([
      { label: "Allow once", value: "turn" },
      { label: "Allow session", value: "session" },
      { label: "Decline", value: "decline" }
    ])).toEqual([
      { permission: { optionId: "allow_once", name: "Allow once", kind: "allow_once" }, value: "turn" },
      { permission: { optionId: "allow_always", name: "Allow session", kind: "allow_always" }, value: "session" },
      { permission: { optionId: "reject_once", name: "Decline", kind: "reject_once" }, value: "decline" }
    ]);
  });
});

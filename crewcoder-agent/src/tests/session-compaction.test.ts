import { describe, expect, it } from "vitest";
import { compactLiveMessages, prepareLiveCompaction, applyCompactionProposal } from "../core/session-compaction.js";
import { assistantText, getText, textMessage, type AgentMessage } from "../core/messages.js";
import type { ModelClient } from "../core/model-client.js";

function seedMessages(count: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(i % 2 === 0 ? textMessage("user", `user message ${i}`) : assistantText(`assistant reply ${i}`));
  }
  return messages;
}

describe("compactLiveMessages", () => {
  it("leaves short sessions untouched", async () => {
    const modelClient: ModelClient = { async complete() { throw new Error("should not be called"); } };
    const messages = seedMessages(6);
    const result = await compactLiveMessages(messages, { modelClient, minMessages: 14 });
    expect(result.compaction).toBeUndefined();
    expect(result.messages).toBe(messages);
  });

  it("uses the LLM summary and preserves recent messages", async () => {
    let summarized = false;
    const modelClient: ModelClient = {
      async complete(input) {
        // Compaction calls the model with no tools available.
        expect(input.availableTools).toHaveLength(0);
        summarized = true;
        return assistantText("- Goal: ship auto-compaction\n- Decision: trigger on live context");
      }
    };
    const messages = seedMessages(20);
    const result = await compactLiveMessages(messages, { modelClient, keepRecentMessages: 8, minMessages: 14 });

    expect(summarized).toBe(true);
    expect(result.compaction).toBeDefined();
    expect(result.compaction?.originalMessageCount).toBe(20);
    expect(result.compaction?.retainedMessageCount).toBe(8);
    // background summary + 8 retained = 9 messages
    expect(result.messages).toHaveLength(9);
    expect(getText(result.messages[0]!)).toContain("ship auto-compaction");
    expect(result.messages.slice(1)).toEqual(messages.slice(-8));
  });

  it("falls back to a deterministic summary when the model call fails", async () => {
    const modelClient: ModelClient = { async complete() { throw new Error("provider unavailable"); } };
    const messages = seedMessages(20);
    const result = await compactLiveMessages(messages, { modelClient, keepRecentMessages: 8, minMessages: 14 });

    expect(result.compaction).toBeDefined();
    // Deterministic fallback echoes the compacted transcript content.
    expect(result.compaction?.summary).toContain("user message 0");
  });
});

describe("compaction preview (prepare/apply)", () => {
  it("prepares a proposal without mutating the messages", async () => {
    const modelClient: ModelClient = {
      async complete() { return assistantText("- Goal: preview summary"); }
    };
    const messages = seedMessages(20);
    const proposal = await prepareLiveCompaction(messages, { modelClient, keepRecentMessages: 8, minMessages: 14 });

    expect(proposal).toBeDefined();
    expect(proposal?.source).toBe("model");
    expect(proposal?.summary).toContain("preview summary");
    expect(proposal?.originalMessageCount).toBe(20);
    expect(proposal?.retainedMessageCount).toBe(8);
    // Original list is untouched — nothing installed yet.
    expect(messages).toHaveLength(20);
  });

  it("returns undefined for histories below the minimum", async () => {
    const modelClient: ModelClient = { async complete() { throw new Error("should not be called"); } };
    const proposal = await prepareLiveCompaction(seedMessages(6), { modelClient, minMessages: 14 });
    expect(proposal).toBeUndefined();
  });

  it("marks deterministic proposals when the model fails", async () => {
    const modelClient: ModelClient = { async complete() { throw new Error("down"); } };
    const proposal = await prepareLiveCompaction(seedMessages(20), { modelClient, keepRecentMessages: 8, minMessages: 14 });
    expect(proposal?.source).toBe("deterministic");
  });

  it("applies an edited summary in place of the proposed one", async () => {
    const modelClient: ModelClient = { async complete() { return assistantText("proposed"); } };
    const messages = seedMessages(20);
    const proposal = await prepareLiveCompaction(messages, { modelClient, keepRecentMessages: 8, minMessages: 14 });
    const applied = applyCompactionProposal(proposal!, { editedSummary: "  hand edited summary  " });

    expect(applied.compaction.summary).toBe("hand edited summary");
    expect(getText(applied.messages[0]!)).toContain("hand edited summary");
    expect(applied.messages).toHaveLength(9);
    expect(applied.messages.slice(1)).toEqual(messages.slice(-8));
  });

  it("keeps the proposed summary when the edit is blank", async () => {
    const modelClient: ModelClient = { async complete() { return assistantText("proposed summary"); } };
    const proposal = await prepareLiveCompaction(seedMessages(20), { modelClient, keepRecentMessages: 8, minMessages: 14 });
    const applied = applyCompactionProposal(proposal!, { editedSummary: "   " });
    expect(applied.compaction.summary).toBe("proposed summary");
  });
});

describe("tool-group boundaries", () => {
  const modelClient: ModelClient = { async complete() { return assistantText("- Goal: keep tool groups intact"); } };

  // 1 user + 5 groups of [assistant(2 toolCalls), 2 toolResults] = 16 messages.
  // A plain slice(-8) starts at index 8, inside a group, orphaning one tool result.
  function toolHeavyMessages(): AgentMessage[] {
    const messages: AgentMessage[] = [textMessage("user", "do the work")];
    for (let group = 0; group < 5; group++) {
      messages.push({
        role: "assistant",
        content: [0, 1].map((slot) => ({ type: "toolCall" as const, id: `call_${group}_${slot}`, name: "read", arguments: {} })),
        stopReason: "tool_calls",
        timestamp: Date.now()
      });
      for (const slot of [0, 1]) {
        messages.push({ role: "toolResult", toolCallId: `call_${group}_${slot}`, toolName: "read", content: [{ type: "text", text: `output ${group}.${slot}` }], isError: false, timestamp: Date.now() });
      }
    }
    return messages;
  }

  it("never retains a tool result whose tool call was compacted away", async () => {
    const messages = toolHeavyMessages();
    expect(messages.slice(-8)[0]?.role).toBe("toolResult"); // the bug the fix prevents

    const proposal = await prepareLiveCompaction(messages, { modelClient, keepRecentMessages: 8, minMessages: 14 });
    const applied = applyCompactionProposal(proposal!);

    // Conversation input starts with the background summary, then a clean boundary.
    expect(applied.messages[0]?.role).toBe("user");
    expect(applied.messages[1]?.role).toBe("assistant");

    const callIds = new Set<string>();
    for (const message of applied.messages) {
      if (message.role === "assistant") {
        for (const part of message.content) if (part.type === "toolCall") callIds.add(part.id);
      } else if (message.role === "toolResult") {
        expect(callIds.has(message.toolCallId)).toBe(true);
      }
    }
  });

  it("extends the retained window backwards instead of dropping tool output", async () => {
    const messages = toolHeavyMessages();
    const proposal = await prepareLiveCompaction(messages, { modelClient, keepRecentMessages: 8, minMessages: 14 });

    // slice(-8) would cut mid-group; the boundary moves back to that group's assistant.
    expect(proposal?.retainedMessageCount).toBe(9);
    expect(proposal?.retained).toEqual(messages.slice(-9));
  });

  it("compacts the whole group rather than orphaning it when the tail is one huge tool group", async () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: Array.from({ length: 20 }, (_, slot) => ({ type: "toolCall" as const, id: `call_${slot}`, name: "read", arguments: {} })),
        stopReason: "tool_calls",
        timestamp: Date.now()
      },
      ...Array.from({ length: 20 }, (_, slot): AgentMessage => ({ role: "toolResult", toolCallId: `call_${slot}`, toolName: "read", content: [{ type: "text", text: `output ${slot}` }], isError: false, timestamp: Date.now() }))
    ];

    // Extending backwards would leave nothing to summarize, so the orphans are
    // folded into the summary instead of being sent without their tool call.
    const proposal = await prepareLiveCompaction(messages, { modelClient, keepRecentMessages: 8, minMessages: 14 });
    expect(proposal?.retained).toEqual([]);
    expect(proposal?.summary).toContain("keep tool groups intact");
  });
});

describe("compaction fallback reporting", () => {
  const messages = seedMessages(20);
  const options = { keepRecentMessages: 8, minMessages: 14 };

  it("records why the summarizer failed when the provider throws", async () => {
    const modelClient: ModelClient = {
      async complete() { throw new Error("Provider codex requires OAuth login. Run: crewcoder login codex"); }
    };

    const proposal = await prepareLiveCompaction(messages, { modelClient, ...options });

    expect(proposal?.source).toBe("deterministic");
    expect(proposal?.fallbackReason).toBe("Provider codex requires OAuth login. Run: crewcoder login codex");
  });

  it("records the provider error when it arrives as an error-stopReason message instead of a throw", async () => {
    const modelClient: ModelClient = {
      async complete() {
        return { role: "assistant" as const, content: [], stopReason: "error" as const, errorMessage: "402 insufficient credits", timestamp: Date.now() };
      }
    };

    const proposal = await prepareLiveCompaction(messages, { modelClient, ...options });

    expect(proposal?.source).toBe("deterministic");
    expect(proposal?.fallbackReason).toBe("402 insufficient credits");
  });

  it("records an empty provider response rather than reporting a healthy summary", async () => {
    const modelClient: ModelClient = { async complete() { return assistantText("   "); } };

    const proposal = await prepareLiveCompaction(messages, { modelClient, ...options });

    expect(proposal?.source).toBe("deterministic");
    expect(proposal?.fallbackReason).toBe("The provider returned an empty summary.");
  });

  it("leaves fallbackReason unset on a healthy model summary", async () => {
    const modelClient: ModelClient = { async complete() { return assistantText("- Goal: ship it"); } };

    const proposal = await prepareLiveCompaction(messages, { modelClient, ...options });

    expect(proposal?.source).toBe("model");
    expect(proposal?.fallbackReason).toBeUndefined();
  });
});

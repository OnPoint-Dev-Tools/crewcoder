import { describe, expect, it } from "vitest";
import { renderSessionHtml, renderSessionMarkdown } from "../core/session-export.js";
import type { SessionRecord } from "../core/session-store.js";
import type { AgentMessage } from "../core/messages.js";

function baseRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session_test",
    startedAt: "2026-07-12T00:00:00.000Z",
    cwd: "/work/repo",
    requestedMode: "auto",
    resolvedMode: "general",
    prompt: "add a feature",
    provider: "codex",
    model: "gpt-5.4-mini",
    events: [],
    messages: [],
    mutationLog: [],
    ...overrides
  };
}

describe("renderSessionMarkdown", () => {
  it("renders the human conversation without internal event or model-turn records", () => {
    const messages: AgentMessage[] = [
      textUser("Please inspect <unsafe>"),
      {
        role: "assistant",
        stopReason: "tool_calls",
        timestamp: 2,
        content: [
          { type: "text", text: "I will inspect it." },
          { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "README.md", note: "contains ```" } }
        ]
      },
      { role: "toolResult", toolCallId: "tc-1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 3 }
    ];
    const markdown = renderSessionMarkdown(baseRecord({ messages, events: [{ type: "agent_start", sessionId: "hidden-event" }] }));

    expect(markdown).toContain("# CrewCoder Conversation");
    expect(markdown).toContain("## User");
    expect(markdown).toContain("Please inspect &lt;unsafe&gt;");
    expect(markdown).toContain("## Assistant");
    expect(markdown).toContain("### Tool call: read");
    expect(markdown).toContain("## Tool result: read");
    expect(markdown).toContain("````json");
    expect(markdown).not.toContain("hidden-event");
  });
});

describe("renderSessionHtml", () => {
  it("produces a self-contained HTML document with no external assets", () => {
    const html = renderSessionHtml(baseRecord());
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).toContain("session_test");
    expect(html).toContain("/work/repo");
  });

  it("escapes user-controlled content to prevent HTML injection", () => {
    const messages: AgentMessage[] = [textUser("<script>alert('x')</script>")];
    const html = renderSessionHtml(baseRecord({ messages, prompt: "<b>hi</b>" }));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("reconstructs diffs from write and edit tool calls", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        stopReason: "tool_calls",
        timestamp: 1,
        content: [
          { type: "toolCall", id: "1", name: "write", arguments: { path: "a.ts", content: "line one\nline two" } },
          { type: "toolCall", id: "2", name: "edit", arguments: { path: "b.ts", find: "old", replace: "new" } }
        ]
      }
    ];
    const html = renderSessionHtml(baseRecord({ messages }));
    expect(html).toContain("write a.ts");
    expect(html).toContain("+ line one");
    expect(html).toContain("edit b.ts");
    expect(html).toContain("- old");
    expect(html).toContain("+ new");
  });

  it("renders a per-model token usage rollup with totals", () => {
    const html = renderSessionHtml(baseRecord({
      usage: {
        turns: 3,
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        byModel: {
          "codex:gpt-5.4-mini": {
            providerId: "codex",
            model: "gpt-5.4-mini",
            inputTokens: 1000,
            outputTokens: 200,
            totalTokens: 1200,
            turns: 3
          }
        }
      }
    }));
    expect(html).toContain("Token usage");
    expect(html).toContain("codex:gpt-5.4-mini");
    expect(html).toContain("1,200");
    expect(html).not.toContain("Cost");
    expect(html).not.toContain("$");
    expect(html).toContain("Total");
  });

  it("marks tool result errors", () => {
    const messages: AgentMessage[] = [
      { role: "toolResult", toolCallId: "1", toolName: "bash", content: [{ type: "text", text: "boom" }], isError: true, timestamp: 1 }
    ];
    const html = renderSessionHtml(baseRecord({ messages }));
    expect(html).toContain("toolResult error");
    expect(html).toContain("boom");
  });
});

function textUser(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

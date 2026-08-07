import { describe, expect, it } from "vitest";
import { parseProviderOutput, providerErrorMessage, providerResponseToAssistantMessage } from "../providers/output-parser.js";

describe("provider output parser", () => {
  it("accepts assistant message envelopes", () => {
    expect(parseProviderOutput(JSON.stringify({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "nested hello" }]
      }
    }))).toEqual({ type: "assistant_text", text: "nested hello" });
  });

  it("normalizes tool call arrays with string arguments", () => {
    const parsed = parseProviderOutput(JSON.stringify({
      text: "I will read it",
      tool_calls: [{
        id: "call_1",
        function: { name: "read", arguments: "{\"path\":\"README.md\"}" }
      }]
    }));

    expect(parsed).toEqual({
      type: "tool_calls",
      text: "I will read it",
      calls: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }]
    });
  });

  it("treats provider error envelopes as errors, not assistant text", () => {
    const parsed = parseProviderOutput(JSON.stringify({
      type: "error",
      error: { type: "CreditsError", message: "Insufficient balance." }
    }));

    expect(parsed.type).toBe("error");
    expect(parsed).toMatchObject({ message: "CreditsError: Insufficient balance." });
  });

  it("marks error responses with stopReason error and errorMessage", () => {
    const message = providerResponseToAssistantMessage({ type: "error", message: "CreditsError: Insufficient balance." });

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("CreditsError: Insufficient balance.");
  });

  it("extracts readable messages from provider error payloads", () => {
    expect(providerErrorMessage(JSON.stringify({ error: { type: "CreditsError", message: "Insufficient balance." } }))).toBe("CreditsError: Insufficient balance.");
    expect(providerErrorMessage(JSON.stringify({ error: "invalid api key" }))).toBe("invalid api key");
    expect(providerErrorMessage(JSON.stringify({ message: "unauthorized" }))).toBe("unauthorized");
    expect(providerErrorMessage("upstream exploded")).toBe("upstream exploded");
    expect(providerErrorMessage("   ")).toBe("Provider request failed with no error output.");
  });
});

import { describe, expect, it, vi } from "vitest";
import { answerCodexMcpElicitation } from "../providers/codex-mcp-elicitation.js";

const consent = { serverName: "computer-use", mode: "form", message: "Allow access to this computer?", requestedSchema: { type: "object", properties: {} } };

describe("Codex MCP elicitation", () => {
  it("asks for actual consent and preserves acceptance and denial", async () => {
    const ask = vi.fn().mockResolvedValue("accept");
    expect(await answerCodexMcpElicitation(consent, ask)).toEqual({ action: "accept", content: {} });
    expect(ask.mock.calls[0]?.[0]).toMatchObject({
      title: expect.stringContaining(consent.message),
      options: [{ label: "Allow once", value: "accept" }, { label: "Decline", value: "decline" }]
    });
    ask.mockResolvedValue("decline");
    expect(await answerCodexMcpElicitation(consent, ask)).toEqual({ action: "decline", content: null });
    ask.mockResolvedValue("unexpected");
    expect(await answerCodexMcpElicitation(consent, ask)).toEqual({ action: "decline", content: null });
  });

  it("cancels when no interactive host or answer is available", async () => {
    expect(await answerCodexMcpElicitation(consent, undefined)).toEqual({ action: "cancel", content: null });
    expect(await answerCodexMcpElicitation(consent, async () => undefined)).toEqual({ action: "cancel", content: null });
  });

  it("refuses late consent after cancellation", async () => {
    const controller = new AbortController();
    expect(await answerCodexMcpElicitation(consent, async () => {
      controller.abort();
      return "accept";
    }, controller.signal)).toEqual({ action: "cancel", content: null });
  });

  it("displays URL authentication for explicit confirmation", async () => {
    const ask = vi.fn().mockResolvedValue("accept");
    expect(await answerCodexMcpElicitation({ ...consent, mode: "url", url: "https://example.com/auth" }, ask))
      .toEqual({ action: "accept", content: null });
    expect(ask.mock.calls[0]?.[0].title).toContain("https://example.com/auth");
  });

  it("requires real JSON form data and fails explicitly on invalid input", async () => {
    const form = { ...consent, requestedSchema: { type: "object", properties: { name: { type: "string" } } } };
    expect(await answerCodexMcpElicitation(form, async () => '{"name":"Cj"}')).toEqual({ action: "accept", content: { name: "Cj" } });
    for (const answer of ["", "accept", "[]", "null"]) {
      await expect(answerCodexMcpElicitation(form, async () => answer)).rejects.toThrow("JSON object");
    }
    await expect(answerCodexMcpElicitation({ ...consent, mode: "unknown" }, async () => "accept")).rejects.toThrow("Unsupported");
  });
});

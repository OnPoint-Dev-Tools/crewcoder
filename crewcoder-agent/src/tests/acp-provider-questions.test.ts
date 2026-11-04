import { describe, expect, it, vi } from "vitest";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { requestProviderQuestion } from "../acp/provider-questions.js";

describe("ACP structured provider question contract", () => {
  it("sends free text through the negotiated extension, never a permission option", async () => {
    const extMethod = vi.fn().mockResolvedValue({ cancelled: false, value: "custom answer" });
    const conn = { signal: new AbortController().signal, extMethod, extNotification: vi.fn() } as unknown as AgentSideConnection;
    expect(await requestProviderQuestion(conn, "session", "question", { title: "What next?" })).toBe("custom answer");
    expect(extMethod).toHaveBeenCalledWith("_crewcoder/request_question", expect.objectContaining({ sessionId: "session", requestId: "question", version: 1, kind: "question", title: "What next?" }));
  });
  it("rejects empty and unoffered choices instead of approving them", async () => {
    const extMethod = vi.fn().mockResolvedValue({ cancelled: false, value: "unoffered" });
    const conn = { signal: new AbortController().signal, extMethod, extNotification: vi.fn() } as unknown as AgentSideConnection;
    const question = { title: "Choose", options: [{ label: "One", value: "one" }] };
    expect(await requestProviderQuestion(conn, "session", "question", question)).toBeUndefined();
    extMethod.mockResolvedValue({ cancelled: false, value: " " });
    expect(await requestProviderQuestion(conn, "session", "question", { title: "Text?" })).toBeUndefined();
    extMethod.mockResolvedValue({ cancelled: false, value: "one" });
    expect(await requestProviderQuestion(conn, "session", "question", question)).toBe("one");
  });
  it("withdraws a pending card when the exact provider request is resolved", async () => {
    const controller = new AbortController();
    const extNotification = vi.fn().mockResolvedValue(undefined);
    const conn = { signal: new AbortController().signal, extMethod: vi.fn(() => new Promise(() => {})), extNotification } as unknown as AgentSideConnection;
    const pending = requestProviderQuestion(conn, "session", "question", { title: "Choose?", signal: controller.signal });
    controller.abort();
    expect(await pending).toBeUndefined();
    expect(extNotification).toHaveBeenCalledWith("_crewcoder/question_cancelled", { sessionId: "session", requestId: "question" });
  });
  it("validates multi-select values before returning Claude's answer string", async () => {
    const extMethod = vi.fn().mockResolvedValue({ cancelled: false, values: ["one", "two"] });
    const conn = { signal: new AbortController().signal, extMethod, extNotification: vi.fn() } as unknown as AgentSideConnection;
    const question = { title: "Choose", multiple: true, options: [{ label: "One", value: "one" }, { label: "Two", value: "two" }] };
    expect(await requestProviderQuestion(conn, "session", "question", question)).toBe("one, two");
    extMethod.mockResolvedValue({ cancelled: false, values: ["unoffered"] });
    expect(await requestProviderQuestion(conn, "session", "question", question)).toBeUndefined();
  });
});

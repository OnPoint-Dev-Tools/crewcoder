import { describe, expect, it, vi } from "vitest";
import { answerCodexUserInput } from "../providers/codex-user-input.js";

describe("Codex request_user_input", () => {
  const params = { questions: [{ id: "design", header: "Approach", question: "Which approach?", options: [{ label: "Minimal", description: "Small change" }], isOther: true, isSecret: false }] };
  it("collects a real option or Other answer under the original question id", async () => {
    const ask = vi.fn().mockResolvedValue("custom approach");
    expect(await answerCodexUserInput(params, ask)).toEqual({ design: { answers: ["custom approach"] } });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: "Which approach?", allowFreeform: true, options: [{ label: "Minimal", value: "Minimal", description: "Small change" }] }));
  });
  it("fails explicitly for cancellation, invalid choices, and empty answers", async () => {
    for (const answer of [undefined, "", " "]) await expect(answerCodexUserInput(params, async () => answer)).rejects.toThrow("cancelled");
    await expect(answerCodexUserInput({ questions: [{ ...params.questions[0], isOther: false }] }, async () => "unoffered")).rejects.toThrow("cancelled");
    await expect(answerCodexUserInput(params, undefined)).rejects.toThrow("unavailable");
  });
  it("does not send a late response after provider-side resolution", async () => {
    const controller = new AbortController();
    await expect(answerCodexUserInput(params, async () => { controller.abort(); return "Minimal"; }, controller.signal)).rejects.toThrow("cancelled");
  });
});

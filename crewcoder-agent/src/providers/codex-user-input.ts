import type { ModelStreamCallbacks } from "../core/model-client.js";

export async function answerCodexUserInput(
  params: Record<string, unknown>, requestQuestion: ModelStreamCallbacks["requestQuestion"], signal?: AbortSignal
): Promise<Record<string, { answers: string[] }>> {
  if (!requestQuestion || signal?.aborted) throw new Error("Interactive user input is unavailable");
  if (!Array.isArray(params.questions) || params.questions.length === 0 || params.questions.length > 100) throw new Error("Codex request_user_input had no valid questions");
  const answers: Record<string, { answers: string[] }> = {};
  for (const value of params.questions) {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id || Object.hasOwn(answers, value.id)
      || typeof value.question !== "string" || !value.question.trim()) throw new Error("Invalid Codex question");
    const options = Array.isArray(value.options) ? value.options.map((option) => {
      if (!isRecord(option) || typeof option.label !== "string" || !option.label.trim()) throw new Error("Invalid Codex question option");
      return { label: option.label, value: option.label, description: typeof option.description === "string" ? option.description : undefined };
    }) : [];
    const freeText = value.isOther === true || options.length === 0;
    const answer = await requestQuestion({
      title: value.question, message: typeof value.header === "string" ? value.header : undefined,
      options: options.length ? options : undefined, allowFreeform: freeText,
      placeholder: freeText ? "reply to Codex…" : undefined, secret: value.isSecret === true, signal
    });
    if (signal?.aborted || !answer?.trim() || (!freeText && !options.some(option => option.value === answer))) throw new Error("User cancelled request_user_input");
    Object.defineProperty(answers, value.id, { value: { answers: [answer] }, enumerable: true, configurable: true });
  }
  return answers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

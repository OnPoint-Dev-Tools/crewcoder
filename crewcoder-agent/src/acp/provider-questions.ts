import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { ModelQuestion } from "../core/model-client.js";

export const CREWCODER_QUESTIONS_META = { version: 1, method: "_crewcoder/request_question" } as const;

export async function requestProviderQuestion(
  conn: AgentSideConnection, sessionId: string, requestId: string, question: ModelQuestion, turnSignal?: AbortSignal
): Promise<string | undefined> {
  const signals = [turnSignal, question.signal, conn.signal].filter((value): value is AbortSignal => Boolean(value));
  const signal = AbortSignal.any(signals);
  if (signal.aborted) return undefined;
  let cancel: () => void = () => undefined;
  const cancelled = new Promise<undefined>((resolve) => {
    cancel = () => {
      resolve(undefined);
      void conn.extNotification("_crewcoder/question_cancelled", { sessionId, requestId }).catch(() => undefined);
    };
  });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await Promise.race([
      conn.extMethod(CREWCODER_QUESTIONS_META.method, {
        sessionId, requestId, version: 1, title: question.title,
        kind: question.kind ?? "question", options: question.options,
        placeholder: question.placeholder, allowFreeform: question.allowFreeform,
        secret: question.secret, multiple: question.multiple, message: question.message, detail: question.detail
      }),
      cancelled
    ]);
    if (signal.aborted || response?.cancelled !== false) return undefined;
    if (question.multiple && Array.isArray(response.values)) {
      const values = response.values;
      if (!values.length || values.length > 100 || !values.every((value): value is string => typeof value === "string" && Boolean(value.trim())
        && (question.allowFreeform === true || question.options?.some(option => option.value === value) === true))) return undefined;
      return values.join(", ");
    }
    if (typeof response.value !== "string" || !response.value.trim()) return undefined;
    const value = response.value;
    const matchesOption = question.options?.some((option) => option.value === value);
    // The host may return free text only when the provider offered it.
    if (question.options?.length && !matchesOption && !question.allowFreeform) return undefined;
    return value;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

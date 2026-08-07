import type { AgentMessage } from "./messages.js";
import { getText, textMessage } from "./messages.js";
import type { ModelClient } from "./model-client.js";

export type SessionCompaction = {
  id: string;
  createdAt: string;
  originalMessageCount: number;
  retainedMessageCount: number;
  summary: string;
};

const DEFAULT_KEEP_RECENT_MESSAGES = 8;
const DEFAULT_CONTINUATION_MIN_MESSAGES = 30;
const DEFAULT_LIVE_MIN_MESSAGES = 14;
const MAX_SUMMARY_CHARS = 6000;
const MAX_TRANSCRIPT_CHARS = 24_000;

const SUMMARY_SYSTEM_PROMPT = [
  "You are compacting an in-progress coding session to free up context window space.",
  "Produce a comprehensive but concise summary of the conversation excerpt below so the agent",
  "can keep working without the original messages. Preserve, in this order:",
  "1. The user's goals and any explicit instructions or constraints still in effect.",
  "2. Key decisions made and the reasoning behind them.",
  "3. Files created or modified and what changed in each.",
  "4. Important findings, errors encountered, and their resolutions.",
  "5. Open threads / what is left to do next.",
  "Use compact markdown bullet points. Do not invent details. Output only the summary."
].join("\n");

/**
 * Where the retained window may begin without orphaning a tool result.
 *
 * A plain `slice(-keepRecentMessages)` can cut through an assistant -> toolResult
 * group and retain tool results whose originating tool call was compacted away.
 * Those become `function_call_output` / `tool_result` items with no matching call,
 * which providers reject or answer with an empty stream — the Codex symptom was a
 * turn that ended without assistant text, tool calls, or completion metadata, and
 * every later resume replayed the same broken prefix.
 */
function retainedStartIndex(messages: AgentMessage[], keepRecentMessages: number): number {
  const naive = Math.max(0, messages.length - keepRecentMessages);
  let start = naive;
  // Prefer extending the window backwards onto the assistant message that owns
  // the leading tool results, so no tool output is lost.
  while (start > 0 && messages[start]?.role === "toolResult") start--;
  if (start > 0) return start;
  // Extending backwards would leave nothing to compact, so drop the orphans instead.
  start = naive;
  while (start < messages.length && messages[start]?.role === "toolResult") start++;
  return start;
}

export function compactMessagesForContinuation(
  messages: AgentMessage[],
  options: { keepRecentMessages?: number; minMessages?: number } = {}
): { messages: AgentMessage[]; compaction?: SessionCompaction } {
  const keepRecentMessages = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;
  const minMessages = options.minMessages ?? DEFAULT_CONTINUATION_MIN_MESSAGES;
  if (messages.length <= minMessages) return { messages };

  const start = retainedStartIndex(messages, keepRecentMessages);
  if (start === 0) return { messages };
  const retained = messages.slice(start);
  const compacted = messages.slice(0, start);
  const summary = summarizeMessages(compacted);
  const compaction: SessionCompaction = {
    id: `compact_${Date.now()}`,
    createdAt: new Date().toISOString(),
    originalMessageCount: messages.length,
    retainedMessageCount: retained.length,
    summary
  };
  const background = textMessage("user", `Background from compacted earlier session:\n${summary}`);
  background.background = ["This synthetic message preserves older session context after deterministic compaction."];
  return { messages: [background, ...retained], compaction };
}

export type LiveCompactionOptions = {
  modelClient: ModelClient;
  keepRecentMessages?: number;
  minMessages?: number;
  signal?: AbortSignal;
};

/**
 * A proposed compaction that has been summarized but NOT yet installed. Lets the
 * agent loop (or CLI) preview the summary — and optionally edit it — before the
 * older messages are actually replaced. See `applyCompactionProposal`.
 */
export type CompactionProposal = {
  summary: string;
  source: "model" | "deterministic";
  retained: AgentMessage[];
  originalMessageCount: number;
  retainedMessageCount: number;
  /**
   * Why the LLM summarizer was not used. Set only when `source` is `deterministic`, so callers
   * can report a degraded summary instead of silently shipping a worse one.
   */
  fallbackReason?: string;
};

/**
 * Generate a compaction summary without installing it. Runs the LLM summarizer
 * (deterministic transcript fallback) over the older slice and returns the
 * proposal, or `undefined` when the history is still too small to compact.
 */
export async function prepareLiveCompaction(
  messages: AgentMessage[],
  options: LiveCompactionOptions
): Promise<CompactionProposal | undefined> {
  const keepRecentMessages = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;
  const minMessages = options.minMessages ?? DEFAULT_LIVE_MIN_MESSAGES;
  if (messages.length <= minMessages) return undefined;

  const start = retainedStartIndex(messages, keepRecentMessages);
  if (start === 0) return undefined;
  const retained = messages.slice(start);
  const compacted = messages.slice(0, start);
  const modelSummary = await summarizeWithModel(compacted, options);
  return {
    summary: modelSummary.text ?? summarizeMessages(compacted),
    source: modelSummary.text ? "model" : "deterministic",
    retained,
    originalMessageCount: messages.length,
    retainedMessageCount: retained.length,
    fallbackReason: modelSummary.text ? undefined : modelSummary.fallbackReason
  };
}

/**
 * Install a prepared compaction, replacing the older slice with a single
 * synthetic background message. `editedSummary` (when non-empty) overrides the
 * proposed summary so a user-reviewed edit can be applied.
 */
export function applyCompactionProposal(
  proposal: CompactionProposal,
  options: { editedSummary?: string; note?: string } = {}
): { messages: AgentMessage[]; compaction: SessionCompaction } {
  const edited = options.editedSummary?.trim();
  const summary = edited ? truncate(edited, MAX_SUMMARY_CHARS) : proposal.summary;
  const compaction: SessionCompaction = {
    id: `compact_${Date.now()}`,
    createdAt: new Date().toISOString(),
    originalMessageCount: proposal.originalMessageCount,
    retainedMessageCount: proposal.retainedMessageCount,
    summary
  };
  const background = textMessage("user", `Background from compacted earlier session:\n${summary}`);
  background.background = [options.note ?? "This synthetic message preserves older session context after token-triggered compaction."];
  return { messages: [background, ...proposal.retained], compaction };
}

/**
 * Token-triggered, mid-session compaction. Replaces older messages with a single
 * synthetic background message holding a comprehensive, LLM-generated summary.
 * Falls back to the deterministic transcript summary if the model call fails or
 * returns nothing, so compaction never blocks the loop.
 */
export async function compactLiveMessages(
  messages: AgentMessage[],
  options: LiveCompactionOptions
): Promise<{ messages: AgentMessage[]; compaction?: SessionCompaction }> {
  const proposal = await prepareLiveCompaction(messages, options);
  if (!proposal) return { messages };
  return applyCompactionProposal(proposal);
}

type ModelSummaryOutcome = { text?: string; fallbackReason?: string };

/**
 * Falling back to the deterministic summary must never block the loop, but it must never be
 * silent either: a degraded summary caused by expired auth or a billing failure is otherwise
 * indistinguishable from a healthy one, and the only symptom is the agent quietly getting worse
 * after long sessions. Every failure path here records why.
 */
async function summarizeWithModel(messages: AgentMessage[], options: LiveCompactionOptions): Promise<ModelSummaryOutcome> {
  const transcript = buildTranscript(messages);
  if (!transcript) return { fallbackReason: "No text content was available to summarize." };
  try {
    const assistant = await options.modelClient.complete(
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [textMessage("user", `Conversation excerpt to summarize:\n\n${transcript}`)],
        availableTools: []
      },
      options.signal
    );
    // Provider failures arrive as an error-stopReason message rather than a throw, so this is a
    // second silent path that would otherwise look like an empty response.
    if (assistant.stopReason === "error") {
      return { fallbackReason: assistant.errorMessage?.trim() || "The provider returned an error while summarizing." };
    }
    const text = getText(assistant).trim();
    if (!text) return { fallbackReason: "The provider returned an empty summary." };
    return { text: truncate(text, MAX_SUMMARY_CHARS) };
  } catch (error) {
    return { fallbackReason: error instanceof Error ? error.message : String(error) };
  }
}

function buildTranscript(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const text = getText(message).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const prefix = message.role === "toolResult" ? `tool:${message.toolName}` : message.role;
    lines.push(`${prefix}: ${text}`);
  }
  return truncate(lines.join("\n"), MAX_TRANSCRIPT_CHARS);
}

export function summarizeMessagesForHandoff(messages: AgentMessage[]): string {
  return summarizeMessages(messages);
}

function summarizeMessages(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const text = getText(message).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const prefix = message.role === "toolResult" ? `tool:${message.toolName}` : message.role;
    lines.push(`- ${prefix}: ${truncate(text, 500)}`);
  }
  const summary = lines.join("\n");
  return truncate(summary || "No text content was available in the compacted messages.", MAX_SUMMARY_CHARS);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

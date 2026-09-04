import { loadTrustedExtensionHooks, runCompactionHooks } from "../extensions/extension-hooks.js";
import { closeCodexWebSocketSessions } from "../providers/codex-websocket-transport.js";
import type { AgentEvent } from "./events.js";
import type { ModelClient } from "./model-client.js";
import { loadSession } from "./session-loader.js";
import { applyCompactionProposal, prepareLiveCompaction } from "./session-compaction.js";
import { saveSession, type SessionRecord } from "./session-store.js";

export type CompactDurableSessionOptions = {
  sessionId: string;
  modelClient: ModelClient;
  cwd?: string;
  /** Prepare the summary and return it without rewriting the session. */
  preview?: boolean;
  /** Install this text instead of the generated summary. */
  editedSummary?: string;
  emit?: (event: AgentEvent) => Promise<void> | void;
  /**
   * Host-triggered compaction is never automatic. The ACP adapter sets this false
   * so CrewCode can tell a compact-button apply from token-triggered live compact.
   */
  automatic?: boolean;
};

export type CompactDurableSessionResult = {
  compacted: boolean;
  preview: boolean;
  edited: boolean;
  originalMessageCount: number;
  retainedMessageCount: number;
  summary: string;
  hookNotes: string[];
  compactionId?: string;
  source?: "model" | "deterministic";
  fallbackReason?: string;
};

/**
 * Compact a saved CrewCoder session in place. Shared by `crewcoder session compact`
 * and ACP `session/compact` so a host compact button rewrites the durable record
 * the next prompt will resume from, rather than only resetting the client's UI.
 */
export async function compactDurableSession(options: CompactDurableSessionOptions): Promise<CompactDurableSessionResult> {
  const record = await loadSession(options.sessionId);
  const originalMessageCount = record.messages.length;
  const automatic = options.automatic === true;
  const edited = Boolean(options.editedSummary?.trim());
  const emit = async (event: AgentEvent): Promise<void> => {
    await options.emit?.(event);
  };

  await emit({
    type: "session_compaction_progress",
    phase: "requested",
    percent: 5,
    message: "Compacting saved session context…",
    originalMessageCount,
    retainedMessageCount: Math.min(8, originalMessageCount),
    automatic
  });

  try {
    await emit({
      type: "session_compaction_progress",
      phase: "summarizing",
      percent: 35,
      message: "Summarizing older conversation context…",
      originalMessageCount,
      retainedMessageCount: Math.min(8, originalMessageCount),
      automatic
    });

    let proposal = await prepareLiveCompaction(record.messages, { modelClient: options.modelClient });
    if (!proposal) {
      await emit({
        type: "session_compaction_progress",
        phase: "skipped",
        percent: 100,
        message: "Nothing to compact yet; the conversation is still small.",
        originalMessageCount,
        retainedMessageCount: originalMessageCount,
        automatic
      });
      return {
        compacted: false,
        preview: Boolean(options.preview),
        edited: false,
        originalMessageCount,
        retainedMessageCount: originalMessageCount,
        summary: "",
        hookNotes: []
      };
    }

    const hookOutcome = await runCompactionHooks(await loadTrustedExtensionHooks(), {
      summary: proposal.summary,
      source: proposal.source,
      fallbackReason: proposal.fallbackReason,
      originalMessageCount: proposal.originalMessageCount,
      retainedMessageCount: proposal.retainedMessageCount,
      cwd: options.cwd ?? record.cwd,
      sessionId: options.sessionId
    });
    if (hookOutcome.summary !== proposal.summary) proposal = { ...proposal, summary: hookOutcome.summary };

    if (options.preview) {
      await emit({
        type: "session_compaction_progress",
        phase: "skipped",
        percent: 100,
        message: "Compaction preview only; saved context left unchanged.",
        originalMessageCount: proposal.originalMessageCount,
        retainedMessageCount: proposal.retainedMessageCount,
        automatic
      });
      return {
        compacted: false,
        preview: true,
        edited: false,
        originalMessageCount: proposal.originalMessageCount,
        retainedMessageCount: proposal.retainedMessageCount,
        summary: proposal.summary,
        hookNotes: hookOutcome.notes,
        source: proposal.source,
        fallbackReason: proposal.fallbackReason
      };
    }

    const applied = applyCompactionProposal(proposal, { editedSummary: options.editedSummary });
    await emit({
      type: "session_compaction_progress",
      phase: "saving",
      percent: 80,
      message: "Installing compacted context…",
      originalMessageCount: applied.compaction.originalMessageCount,
      retainedMessageCount: applied.compaction.retainedMessageCount,
      automatic
    });

    const updated: SessionRecord = {
      ...record,
      messages: applied.messages,
      compactions: [...(record.compactions ?? []), applied.compaction],
      usage: record.usage ? { ...record.usage, lastInputTokens: 0 } : record.usage,
      providerSessionIds: {}
    };
    await saveSession(updated);
    closeCodexWebSocketSessions(options.sessionId);

    await emit({
      type: "session_compacted",
      compactionId: applied.compaction.id,
      originalMessageCount: applied.compaction.originalMessageCount,
      retainedMessageCount: applied.compaction.retainedMessageCount,
      summary: applied.compaction.summary,
      automatic
    });

    return {
      compacted: true,
      preview: false,
      edited,
      originalMessageCount: applied.compaction.originalMessageCount,
      retainedMessageCount: applied.compaction.retainedMessageCount,
      summary: applied.compaction.summary,
      hookNotes: hookOutcome.notes,
      compactionId: applied.compaction.id,
      source: proposal.source,
      fallbackReason: proposal.fallbackReason
    };
  } catch (error) {
    await emit({
      type: "session_compaction_progress",
      phase: "failed",
      percent: 100,
      message: `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
      originalMessageCount,
      retainedMessageCount: originalMessageCount,
      automatic
    });
    throw error;
  }
}

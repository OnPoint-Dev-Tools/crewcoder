import type { AgentLoopOptions } from "./agent-loop.js";
import type { AgentEventSink } from "./events.js";
import { createExtensionUiBridge } from "./extension-ui-bridge.js";
import { attachStdinControlListener, type ApprovalControlDecision, type CompactionPreviewDecision } from "./stdin-control.js";

/** The live-control options a `--json-events` run hands to every agent loop it starts. */
export type RunControlOptions = Required<Pick<AgentLoopOptions, "manualCompactSignal" | "compactionPreviewSignal" | "followUpSignal" | "uiBridge">>
  & Pick<AgentLoopOptions, "approvalSignal">;

export type RunControls = {
  options: RunControlOptions;
  /** Cancel open extension questions and stop reading stdin. */
  close(): void;
};

/**
 * The stdin control channel for a CLI run: approvals, follow-ups, compaction,
 * and extension answers from the TUI. Without a JSON event sink there is no
 * host to answer, so approvals stay non-interactive (the loop denies them) and
 * stdin is left alone. `run`, `crew run`, and `crew team run` share this so a
 * crew answers approvals exactly like a single run; a crew passes the same
 * signals to each worker, so decisions reach whichever worker is running.
 */
export function createRunControls(jsonSink: AgentEventSink | undefined): RunControls {
  const manualCompactSignal = { requested: false, preview: false };
  const compactionPreviewSignal = { decisions: [] as CompactionPreviewDecision[] };
  const followUpSignal = { messages: [] as string[] };
  const approvalSignal = { decisions: [] as ApprovalControlDecision[] };
  const uiBridge = createExtensionUiBridge({ emit: jsonSink, hasUI: Boolean(jsonSink) });
  const detach = jsonSink ? attachStdinControlListener({
    onCompact: (opts) => { manualCompactSignal.requested = true; if (opts.preview) manualCompactSignal.preview = true; },
    onCompactPreviewDecision: (decision) => { compactionPreviewSignal.decisions.push(decision); },
    onFollowUp: (message) => { followUpSignal.messages.push(message); },
    onApprovalDecision: (decision) => { approvalSignal.decisions.push(decision); },
    onUiResponse: (response) => { uiBridge.resolveResponse(response.requestId, response.value); }
  }) : undefined;
  return {
    options: {
      manualCompactSignal,
      compactionPreviewSignal,
      followUpSignal,
      approvalSignal: jsonSink ? approvalSignal : undefined,
      uiBridge
    },
    close() {
      uiBridge.cancelAll();
      detach?.();
    }
  };
}

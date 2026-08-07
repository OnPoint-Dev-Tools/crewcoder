/**
 * Newline-delimited JSON control channel over stdin.
 *
 * The TUI drives the backend as a child process and writes control messages to
 * its stdin (e.g. `{"type":"control","action":"compact"}`). This lets the user
 * trigger actions — like mid-run compaction — against the *live* agent loop
 * instead of the last saved session snapshot.
 *
 * Non-control / unparseable lines are ignored so ordinary stdin noise never
 * crashes a run.
 */
export type ControlAction = "compact" | "compact_preview" | "follow_up" | "approval" | "ui_response";

export type ApprovalControlDecision = {
  approvalId: string;
  approved: boolean;
  reason?: string;
};

export type CompactionPreviewDecision = {
  previewId: string;
  approved: boolean;
  /** Optional user-edited summary to install instead of the proposed one. */
  summary?: string;
};

export type UiControlResponse = {
  requestId: string;
  value: string | boolean | null;
};

export type ControlListenerHandlers = {
  onCompact?: (options: { preview: boolean }) => void;
  onCompactPreviewDecision?: (decision: CompactionPreviewDecision) => void;
  onFollowUp?: (message: string) => void;
  onApprovalDecision?: (decision: ApprovalControlDecision) => void;
  onUiResponse?: (response: UiControlResponse) => void;
};

export function attachStdinControlListener(handlers: ControlListenerHandlers): () => void {
  let buffer = "";
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handleLine(line, handlers);
      index = buffer.indexOf("\n");
    }
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);
  process.stdin.resume();

  return () => {
    process.stdin.off("data", onData);
    process.stdin.pause();
  };
}

function handleLine(line: string, handlers: ControlListenerHandlers): void {
  let parsed: { type?: unknown; action?: unknown; message?: unknown; approvalId?: unknown; approved?: unknown; reason?: unknown; requestId?: unknown; value?: unknown; previewId?: unknown; summary?: unknown; preview?: unknown };
  try {
    parsed = JSON.parse(line) as { type?: unknown; action?: unknown; message?: unknown; approvalId?: unknown; approved?: unknown; reason?: unknown; requestId?: unknown; value?: unknown; previewId?: unknown; summary?: unknown; preview?: unknown };
  } catch {
    return;
  }
  if (parsed.type !== "control") return;
  if (parsed.action === "compact") handlers.onCompact?.({ preview: parsed.preview === true });
  if (parsed.action === "compact_preview" && typeof parsed.previewId === "string" && typeof parsed.approved === "boolean") {
    const previewId = parsed.previewId.trim();
    if (!previewId) return;
    handlers.onCompactPreviewDecision?.({
      previewId,
      approved: parsed.approved,
      summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary : undefined
    });
  }
  if (parsed.action === "follow_up" && typeof parsed.message === "string") {
    const message = parsed.message.trim();
    if (message) handlers.onFollowUp?.(message);
  }
  if (parsed.action === "approval" && typeof parsed.approvalId === "string" && typeof parsed.approved === "boolean") {
    const approvalId = parsed.approvalId.trim();
    if (!approvalId) return;
    handlers.onApprovalDecision?.({
      approvalId,
      approved: parsed.approved,
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : undefined
    });
  }
  if (parsed.action === "ui_response" && typeof parsed.requestId === "string") {
    const requestId = parsed.requestId.trim();
    if (!requestId) return;
    const value = parsed.value;
    if (typeof value === "string" || typeof value === "boolean" || value === null) {
      handlers.onUiResponse?.({ requestId, value });
    } else if (value === undefined) {
      handlers.onUiResponse?.({ requestId, value: null });
    }
  }
}

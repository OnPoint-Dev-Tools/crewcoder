import type { CrewCoderJsonEvent } from "../bridge/event-parser.js";
import { eventToText } from "../bridge/event-parser.js";
import { pushSystemLog, type TuiCheckpoint, type TuiDeclarativeComponent, type TuiReviewIssueReference, type TuiSafetyPolicy, type TuiState, type TuiUiAction } from "./tui-store.js";
import type { TuiUsageSummary } from "./usage.js";
import { toolImageAttachments } from "./image-attachment.js";

export function applyCrewCoderEvent(state: TuiState, event: CrewCoderJsonEvent): void {
  switch (event.type) {
    case "tui_process_start":
      state.running = true;
      break;
    case "agent_start":
      state.running = true;
      if (typeof event.sessionId === "string") state.sessionId = event.sessionId;
      break;
    case "crew_start": {
      const workers = stringArray(event.workers) ?? [];
      state.running = true;
      state.crewWorkers = workers.map((name) => ({ name, status: "pending" }));
      state.blocks.push({ type: "crew", workers: state.crewWorkers, completed: false });
      break;
    }
    case "crew_worker_start":
      state.running = true;
      updateCrewWorker(state, String(event.worker ?? "unknown"), "running", typeof event.sessionId === "string" ? event.sessionId : undefined);
      break;
    case "crew_worker_end":
      updateCrewWorker(state, String(event.worker ?? "unknown"), event.status === "failed" ? "failed" : "completed", typeof event.sessionId === "string" ? event.sessionId : undefined, typeof event.error === "string" ? event.error : undefined);
      break;
    case "crew_end":
      updateCrewBlock(state, true);
      state.running = false;
      break;
    case "message_end": {
      const text = eventToText(event);
      const role = messageRole(event);
      if (!text || text === "message completed") break;
      if (role === "assistant") {
        // Providers that run their own internal loop (Claude Agent SDK) stream several
        // text segments per turn, so the final message text is a concatenation that
        // matches no individual streamed block. Anything already streamed is rendered.
        const streamed = state.streamedAssistantTurn === true;
        state.streamedAssistantTurn = false;
        if (!streamed && !isDuplicateAssistantText(state, text)) state.blocks.push({ type: "assistant", text });
        setLatestAssistantRate(state, tokensPerSecond(event));
      } else if (role === "user") {
        if (!isDuplicateUserText(state, text)) state.blocks.push({ type: "user", text, background: messageBackground(event) });
      }
      break;
    }
    case "assistant_delta": {
      const text = String(event.text ?? "");
      if (text) state.streamedAssistantTurn = true;
      appendAssistantDelta(state, text);
      break;
    }
    case "thinking_delta":
      appendThinkingDelta(state, String(event.text ?? ""));
      break;
    case "usage_update":
      state.usage = normalizeUsageSummary(event.summary) ?? state.usage;
      break;
    case "token_budget_warning":
      state.blocks.push({ type: "system", text: `Token budget warning: ${String(event.used ?? "?")}/${String(event.limit ?? "?")} tokens used (${String(event.percent ?? 80)}%).` });
      break;
    case "token_budget_exceeded":
      state.blocks.push({ type: "error", text: `Token budget reached: ${String(event.used ?? "?")}/${String(event.limit ?? "?")} tokens.` });
      break;
    case "review_summary": {
      const summary = reviewSummaryFromEvent(event.summary);
      if (summary) state.blocks.push({ type: "review_summary", summary });
      else state.blocks.push({ type: "error", text: "Invalid review summary payload." });
      break;
    }
    case "verification_start":
      state.blocks.push({ type: "system", text: `Verification started: ${Array.isArray(event.checks) ? event.checks.join(", ") : "checks"}` });
      break;
    case "verification_end":
      state.blocks.push(event.ok === true
        ? { type: "system", text: "Verification passed." }
        : { type: "error", text: "Verification failed. Review the verification event output." });
      break;
    case "tool_execution_start":
      state.blocks.push({
        type: "tool",
        id: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
        name: String(event.toolName ?? "unknown"),
        status: "running",
        args: objectRecord(event.args),
        metadata: objectRecord(event.metadata)
      });
      break;
    case "tool_delta":
      appendToolDelta(state, String(event.toolName ?? "unknown"), String(event.text ?? ""), typeof event.toolCallId === "string" ? event.toolCallId : undefined, objectRecord(event.metadata));
      break;
    case "tool_execution_end": {
      const metadata = objectRecord(event.metadata);
      updateTool(state, String(event.toolName ?? "unknown"), event.isError ? "error" : "done", toolResultText(event), typeof event.toolCallId === "string" ? event.toolCallId : undefined, metadata);
      // A tool that declares `details.images` gets those images blitted inline
      // under its output, the same way a pasted screenshot renders.
      if (!event.isError) {
        pushToolImages(state, metadata);
        trackMutationToolPaths(state, String(event.toolName ?? "unknown"), metadata);
      }
      break;
    }
    case "file_changed": {
      const path = String(event.path ?? "");
      if (path && !state.changedFiles.includes(path)) state.changedFiles.push(path);
      break;
    }
    case "background_job_start":
      state.blocks.push({ type: "background_job", bgId: String(event.bgId ?? "unknown"), command: String(event.command ?? ""), status: "running", output: "", startedAt: typeof event.startedAt === "string" ? event.startedAt : undefined });
      break;
    case "background_job_output":
      updateBackgroundJob(state, String(event.bgId ?? ""), { outputDelta: String(event.text ?? "") });
      break;
    case "background_job_status":
      updateBackgroundJob(state, String(event.bgId ?? ""), {
        command: typeof event.command === "string" ? event.command : undefined,
        status: backgroundJobStatus(event.status),
        output: typeof event.output === "string" ? event.output : undefined,
        exitCode: typeof event.exitCode === "number" || event.exitCode === null ? event.exitCode : undefined,
        endedAt: typeof event.endedAt === "string" ? event.endedAt : undefined
      });
      break;
    case "background_job_end":
      updateBackgroundJob(state, String(event.bgId ?? ""), { status: backgroundJobStatus(event.status), exitCode: typeof event.exitCode === "number" || event.exitCode === null ? event.exitCode : undefined, endedAt: typeof event.endedAt === "string" ? event.endedAt : undefined });
      break;
    case "backend_debug":
      if (event.level === "error") state.blocks.push({ type: "error", text: eventToText(event) });
      else pushSystemLog(state, eventToText(event));
      break;
    case "approval_required":
      state.blocks.push({
        type: "approval",
        id: typeof event.approvalId === "string" ? event.approvalId : undefined,
        toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
        toolName: typeof event.toolName === "string" ? event.toolName : undefined,
        risk: typeof event.risk === "string" ? event.risk : undefined,
        text: String(event.reason ?? eventToText(event)),
        args: objectRecord(event.args),
        status: "pending"
      });
      break;
    case "approval_resolved":
      updateApproval(state, typeof event.approvalId === "string" ? event.approvalId : undefined, event.approved === false ? "denied" : "approved", typeof event.reason === "string" ? event.reason : undefined);
      pushSystemLog(state, eventToText(event));
      break;
    case "extension_safety_policies":
      state.safetyPolicies = safetyPolicies(event.policies);
      pushSystemLog(state, eventToText(event));
      break;
    case "checkpoint_created": {
      const checkpoint = checkpointFromEvent(event);
      if (checkpoint && !state.checkpoints.some((item) => item.id === checkpoint.id)) {
        // Keep rewind metadata without adding checkpoint-save noise to the transcript.
        state.checkpoints.push(checkpoint);
      }
      break;
    }
    case "checkpoint_restored":
      pushSystemLog(state, eventToText(event));
      break;
    case "extension_ui_notify": {
      const level = typeof event.level === "string" ? event.level : "info";
      if (level === "error" || level === "warning") state.blocks.push({ type: "error", text: eventToText(event) });
      else pushSystemLog(state, eventToText(event));
      break;
    }
    case "extension_ui_request": {
      const uiKind = event.uiKind === "input" || event.uiKind === "select" || event.uiKind === "component" ? event.uiKind : "confirm";
      state.blocks.push({
        type: "extension_ui",
        requestId: typeof event.requestId === "string" ? event.requestId : "",
        extensionId: typeof event.extensionId === "string" ? event.extensionId : "extension",
        uiKind,
        title: String(event.title ?? "Input requested"),
        message: typeof event.message === "string" ? event.message : undefined,
        placeholder: typeof event.placeholder === "string" ? event.placeholder : undefined,
        defaultValue: typeof event.defaultValue === "string" ? event.defaultValue : undefined,
        options: uiRequestOptions(event.options),
        component: uiRequestComponent(event.component),
        actions: uiRequestActions(event.actions),
        status: "pending"
      });
      break;
    }
    case "extension_ui_resolved":
      updateExtensionUi(state, typeof event.requestId === "string" ? event.requestId : undefined, event.cancelled === true ? "cancelled" : "answered");
      break;
    case "validation_start":
      state.blocks.push({
        type: "validation",
        target: String(event.target ?? "validation"),
        status: "running"
      });
      break;
    case "validation_end":
      updateValidation(
        state,
        String(event.target ?? "validation"),
        event.ok === false ? "failed" : "passed",
        stringArray(event.errors),
        stringArray(event.warnings)
      );
      break;
    case "message_start":
      break;
    case "provider_start":
      pushSystemLog(state, eventToText(event));
      break;
    case "session_compaction_progress":
      updateCompaction(state, compactionStatus(event.phase), numberValue(event.percent, 0), String(event.message ?? eventToText(event)), numberOrUndefined(event.originalMessageCount), numberOrUndefined(event.retainedMessageCount));
      break;
    case "session_compaction_preview":
      pushSystemLog(state, `Compaction preview ready (${String(event.source ?? "model")} summary) — edit and apply in the overlay.`);
      break;
    case "session_compacted":
      updateCompaction(state, "done", 100, eventToText(event), numberOrUndefined(event.originalMessageCount), numberOrUndefined(event.retainedMessageCount));
      break;
    case "provider_end":
      pushSystemLog(state, eventToText(event));
      if (event.usage && typeof event.usage === "object") state.usage = mergeUsage(state.usage, event.usage as Record<string, unknown>);
      break;
    case "turn_start":
      pushSystemLog(state, `Turn ${String(event.iteration ?? "?")} started`);
      break;
    case "turn_end":
      pushSystemLog(state, `Turn ${String(event.iteration ?? "?")} ended`);
      break;
    case "stderr":
    case "process_error":
    case "provider_error":
    case "agent_error":
      state.blocks.push({ type: "error", text: eventToText(event) });
      break;
    case "session_saved":
      if (typeof event.sessionId === "string") state.sessionId = event.sessionId;
      break;
    case "agent_end":
      hydrateSessionMessagesIfEmpty(state, event.messages);
      state.running = false;
      break;
    case "process_exit":
      state.running = false;
      break;
    default: {
      const text = eventToText(event);
      if (text) pushSystemLog(state, text);
    }
  }
  if (state.blocks.length > 500) state.blocks = state.blocks.slice(-500);
}

function updateCrewWorker(state: TuiState, name: string, status: "running" | "completed" | "failed", sessionId?: string, error?: string): void {
  let worker = state.crewWorkers.find((item) => item.name === name);
  if (!worker) {
    worker = { name, status };
    state.crewWorkers.push(worker);
  }
  worker.status = status;
  if (sessionId) worker.sessionId = sessionId;
  if (error) worker.error = error;
  updateCrewBlock(state, false);
}

function updateCrewBlock(state: TuiState, completed: boolean): void {
  for (let index = state.blocks.length - 1; index >= 0; index--) {
    const block = state.blocks[index];
    if (block?.type !== "crew") continue;
    block.workers = state.crewWorkers;
    block.completed = completed;
    return;
  }
  state.blocks.push({ type: "crew", workers: state.crewWorkers, completed });
}

function hydrateSessionMessagesIfEmpty(state: TuiState, messages: unknown): void {
  if (!Array.isArray(messages) || hasConversationBlocks(state)) return;
  const hydrated = messages.flatMap(messageToBlocks);
  if (hydrated.length) state.blocks.push(...hydrated);
}

function hasConversationBlocks(state: TuiState): boolean {
  return state.blocks.some((block) => block.type !== "system");
}

function messageToBlocks(message: unknown): TuiState["blocks"] {
  if (!message || typeof message !== "object") return [];
  const record = message as Record<string, unknown>;
  const role = record.role;
  const text = textFromContent(record.content);
  if (!text) return [];
  // Historical session hydration should show the conversation, not the large
  // repo/status context that was attached to provider input for each live turn.
  if (role === "user") return [{ type: "user", text }];
  if (role === "assistant") return [{ type: "assistant", text }];
  if (role === "toolResult") {
    return [{
      type: "tool",
      id: typeof record.toolCallId === "string" ? record.toolCallId : undefined,
      name: typeof record.toolName === "string" ? record.toolName : "tool",
      status: record.isError === true ? "error" : "done",
      text,
      metadata: objectRecord(record.details)
    }];
  }
  return [];
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? String((part as Record<string, unknown>).text) : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function backgroundFromMessage(message: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(message.background)) return undefined;
  const background = message.background.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  return background.length ? background : undefined;
}

function appendAssistantDelta(state: TuiState, text: string): void {
  const last = state.blocks[state.blocks.length - 1];
  if (last?.type === "assistant") last.text += text;
  else state.blocks.push({ type: "assistant", text });
}

function tokensPerSecond(event: CrewCoderJsonEvent): number | undefined {
  const durationMs = numberOrUndefined(event.durationMs);
  const outputTokens = numberOrUndefined(event.outputTokens);
  if (durationMs === undefined || durationMs <= 0 || outputTokens === undefined || outputTokens <= 0) return undefined;
  return outputTokens / (durationMs / 1_000);
}

function setLatestAssistantRate(state: TuiState, rate: number | undefined): void {
  if (rate === undefined || !Number.isFinite(rate)) return;
  for (let index = state.blocks.length - 1; index >= 0; index--) {
    const block = state.blocks[index];
    if (block?.type !== "assistant") continue;
    block.tokensPerSecond = rate;
    return;
  }
}

function appendThinkingDelta(state: TuiState, text: string): void {
  const last = state.blocks[state.blocks.length - 1];
  if (last?.type === "thinking") last.text += text;
  else state.blocks.push({ type: "thinking", text });
}

function appendToolDelta(state: TuiState, name: string, text: string, id?: string, metadata?: Record<string, unknown>): void {
  const block = findActiveTool(state, name, id);
  if (block) {
    block.text = (block.text ?? "") + text;
    block.metadata = mergeMetadata(block.metadata, metadata);
    return;
  }
  state.blocks.push({ type: "tool", id, name, status: "running", text, metadata });
}

function isDuplicateAssistantText(state: TuiState, text: string): boolean {
  return recentDuplicateText(state, "assistant", text);
}

function isDuplicateUserText(state: TuiState, text: string): boolean {
  return recentDuplicateText(state, "user", text);
}

function recentDuplicateText(state: TuiState, type: "assistant" | "user", text: string): boolean {
  const normalized = text.trim();
  for (let i = state.blocks.length - 1; i >= Math.max(0, state.blocks.length - 8); i--) {
    const block = state.blocks[i];
    if (block?.type === type && block.text.trim() === normalized) return true;
  }
  return false;
}

function messageRole(event: CrewCoderJsonEvent): string | undefined {
  const message = event.message as { role?: unknown } | undefined;
  return typeof message?.role === "string" ? message.role : undefined;
}

function messageBackground(event: CrewCoderJsonEvent): string[] | undefined {
  const message = event.message as { background?: unknown } | undefined;
  if (!Array.isArray(message?.background)) return undefined;
  const background = message.background.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  return background.length ? background : undefined;
}

function updateBackgroundJob(state: TuiState, bgId: string, update: { command?: string; status?: "running" | "completed" | "failed" | "stopped"; output?: string; outputDelta?: string; exitCode?: number | null; endedAt?: string }): void {
  for (let index = state.blocks.length - 1; index >= 0; index--) {
    const block = state.blocks[index];
    if (block?.type !== "background_job" || block.bgId !== bgId) continue;
    if (update.command !== undefined) block.command = update.command;
    if (update.status !== undefined) block.status = update.status;
    if (update.output !== undefined) block.output = update.output;
    if (update.outputDelta !== undefined) block.output = (block.output + update.outputDelta).slice(-120_000);
    if (update.exitCode !== undefined) block.exitCode = update.exitCode;
    if (update.endedAt !== undefined) block.endedAt = update.endedAt;
    return;
  }
}

function backgroundJobStatus(value: unknown): "running" | "completed" | "failed" | "stopped" {
  if (value === "completed" || value === "failed" || value === "stopped") return value;
  return "running";
}

function updateTool(state: TuiState, name: string, status: "done" | "error", text: string, id?: string, metadata?: Record<string, unknown>): void {
  const block = findActiveTool(state, name, id);
  if (block) {
    block.status = status;
    if (!block.text && text) block.text = text;
    block.metadata = mergeMetadata(block.metadata, metadata);
    return;
  }
  state.blocks.push({ type: "tool", id, name, status, text, metadata });
}

function updateApproval(state: TuiState, approvalId: string | undefined, status: "approved" | "denied", reason?: string): void {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i];
    if (block?.type !== "approval") continue;
    if (approvalId && block.id !== approvalId) continue;
    if (!approvalId && block.status !== "pending") continue;
    block.status = status;
    block.resolutionReason = reason;
    return;
  }
}

function updateExtensionUi(state: TuiState, requestId: string | undefined, status: "answered" | "cancelled", answer?: string): void {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i];
    if (block?.type !== "extension_ui") continue;
    if (requestId && block.requestId !== requestId) continue;
    if (!requestId && block.status !== "pending") continue;
    block.status = status;
    if (answer !== undefined) block.answer = answer;
    return;
  }
}

function reviewSummaryFromEvent(value: unknown): Extract<TuiState["blocks"][number], { type: "review_summary" }>["summary"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    branch: typeof record.branch === "string" && record.branch.trim() ? record.branch : undefined,
    clean: record.clean === true,
    changedFiles: stringArray(record.changedFiles) ?? [],
    issueReferences: reviewIssueReferences(record.issueReferences)
  };
}

function reviewIssueReferences(value: unknown): TuiReviewIssueReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.text !== "string") return [];
    return [{
      id: record.id,
      source: typeof record.source === "string" ? record.source : "status",
      text: record.text,
      url: typeof record.url === "string" ? record.url : undefined
    }];
  });
}

function checkpointFromEvent(event: CrewCoderJsonEvent): TuiCheckpoint | undefined {
  if (typeof event.checkpointId !== "string" || typeof event.sessionId !== "string") return undefined;
  return {
    id: event.checkpointId,
    sessionId: event.sessionId,
    reason: typeof event.reason === "string" ? event.reason : "Checkpoint created",
    toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
    toolName: typeof event.toolName === "string" ? event.toolName : undefined,
    fileCount: typeof event.fileCount === "number" ? event.fileCount : 0,
    totalBytes: typeof event.totalBytes === "number" ? event.totalBytes : 0,
    truncated: event.truncated === true
  };
}

function safetyPolicies(raw: unknown): TuiSafetyPolicy[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.extensionId !== "string" || typeof record.policyId !== "string" || typeof record.title !== "string") return [];
    const action = record.action === "allow" || record.action === "review" || record.action === "block" ? record.action : undefined;
    if (!action) return [];
    return [{
      extensionId: record.extensionId,
      policyId: record.policyId,
      title: record.title,
      action,
      reason: typeof record.reason === "string" ? record.reason : undefined,
      tools: stringArray(record.tools) ?? [],
      paths: stringArray(record.paths) ?? [],
      commands: stringArray(record.commands) ?? []
    }];
  });
}

function uiRequestOptions(raw: unknown): Array<{ label: string; value: string; description?: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const options = raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.value !== "string") return [];
    return [{
      label: typeof record.label === "string" ? record.label : record.value,
      value: record.value,
      description: typeof record.description === "string" ? record.description : undefined
    }];
  });
  return options.length ? options : undefined;
}

function uiRequestActions(raw: unknown): TuiUiAction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const actions = raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim()) return [];
    return [{
      id: record.id,
      label: typeof record.label === "string" && record.label.trim() ? record.label : record.id,
      description: typeof record.description === "string" ? record.description : undefined
    }];
  });
  return actions.length ? actions : undefined;
}

function uiRequestComponent(raw: unknown): TuiDeclarativeComponent | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.kind === "markdown" && typeof record.text === "string") return { kind: "markdown", text: record.text };
  if (record.kind === "details" && Array.isArray(record.items)) {
    const items = record.items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const itemRecord = item as Record<string, unknown>;
      if (typeof itemRecord.label !== "string") return [];
      return [{ label: itemRecord.label, value: String(itemRecord.value ?? "") }];
    });
    return { kind: "details", items };
  }
  if (record.kind === "table" && Array.isArray(record.columns) && Array.isArray(record.rows)) {
    const columns = record.columns.flatMap((column) => {
      if (!column || typeof column !== "object") return [];
      const columnRecord = column as Record<string, unknown>;
      if (typeof columnRecord.key !== "string") return [];
      return [{ key: columnRecord.key, label: typeof columnRecord.label === "string" ? columnRecord.label : columnRecord.key }];
    });
    const rows = record.rows.flatMap((row) => row && typeof row === "object" && !Array.isArray(row) ? [primitiveRecord(row as Record<string, unknown>)] : []);
    return { kind: "table", columns, rows };
  }
  if (record.kind === "actionList" && Array.isArray(record.actions)) {
    return { kind: "actionList", actions: uiRequestActions(record.actions) ?? [] };
  }
  return undefined;
}

function primitiveRecord(record: Record<string, unknown>): Record<string, string | number | boolean | null | undefined> {
  const result: Record<string, string | number | boolean | null | undefined> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") result[key] = value;
    else result[key] = JSON.stringify(value);
  }
  return result;
}

function findActiveTool(state: TuiState, name: string, id?: string): Extract<TuiState["blocks"][number], { type: "tool" }> | undefined {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i];
    if (block?.type !== "tool" || block.status !== "running") continue;
    if (id ? block.id === id : block.name === name) return block;
  }
  return undefined;
}

function updateCompaction(state: TuiState, status: "running" | "done" | "skipped" | "failed", percent: number, message: string, originalMessageCount?: number, retainedMessageCount?: number): void {
  const normalizedPercent = Math.max(0, Math.min(100, Math.round(percent)));
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i];
    if (block?.type === "compaction" && block.status === "running") {
      block.status = status;
      block.percent = normalizedPercent;
      block.message = message;
      block.originalMessageCount = originalMessageCount;
      block.retainedMessageCount = retainedMessageCount;
      return;
    }
  }
  state.blocks.push({ type: "compaction", status, percent: normalizedPercent, message, originalMessageCount, retainedMessageCount });
}

function compactionStatus(phase: unknown): "running" | "skipped" | "failed" {
  if (phase === "skipped") return "skipped";
  if (phase === "failed") return "failed";
  return "running";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function updateValidation(state: TuiState, target: string, status: "passed" | "failed", errors?: string[], warnings?: string[]): void {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i];
    if (block?.type === "validation" && block.target === target && block.status === "running") {
      block.status = status;
      block.errors = errors;
      block.warnings = warnings;
      return;
    }
  }
  state.blocks.push({ type: "validation", target, status, errors, warnings });
}

/**
 * Append one image block per renderable image a tool declared. Deduped by
 * attachment id so a tool that re-reports the same file across `tool_delta` and
 * `tool_execution_end` does not stack duplicate placements.
 */
function pushToolImages(state: TuiState, metadata: Record<string, unknown> | undefined): void {
  for (const attachment of toolImageAttachments(metadata)) {
    const alreadyShown = state.blocks.some((block) => block.type === "image" && block.attachment.id === attachment.id);
    if (!alreadyShown) state.blocks.push({ type: "image", attachment });
  }
}

function trackMutationToolPaths(state: TuiState, toolName: string, metadata: Record<string, unknown> | undefined): void {
  if (!metadata || !["write", "edit", "edit_symbol", "edit_transaction"].includes(toolName)) return;
  const paths = [
    ...(typeof metadata.path === "string" ? [metadata.path] : []),
    ...(stringArray(metadata.paths) ?? [])
  ];
  for (const path of paths) {
    if (path && !state.changedFiles.includes(path)) state.changedFiles.push(path);
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function mergeMetadata(current?: Record<string, unknown>, next?: Record<string, unknown>): Record<string, unknown> | undefined {
  const merged = { ...(current ?? {}), ...(next ?? {}) };
  return Object.keys(merged).length ? merged : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => typeof item === "string" ? item : "").filter(Boolean);
  return items.length ? items : undefined;
}

function toolResultText(event: CrewCoderJsonEvent): string {
  const result = event.result as { content?: unknown } | undefined;
  if (result && Array.isArray(result.content)) {
    const text = result.content
      .map((part: any) => typeof part?.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return eventToText(event);
}

function normalizeUsageSummary(value: unknown): TuiUsageSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    inputTokens: numberField(record, "inputTokens"),
    outputTokens: numberField(record, "outputTokens"),
    totalTokens: numberField(record, "totalTokens"),
    cachedInputTokens: numberField(record, "cachedInputTokens"),
    cacheWriteTokens: numberField(record, "cacheWriteTokens"),
    reasoningTokens: numberField(record, "reasoningTokens"),
    turns: numberField(record, "turns") ?? 0,
    contextWindow: numberField(record, "contextWindow"),
    lastInputTokens: numberField(record, "lastInputTokens"),
    tokenBudget: numberField(record, "tokenBudget"),
    budgetExceeded: record.budgetExceeded === true,
    costUsd: numberField(record, "costUsd")
  };
}

function mergeUsage(summary: TuiUsageSummary, usage: Record<string, unknown>): TuiUsageSummary {
  return {
    inputTokens: addOptional(summary.inputTokens, numberField(usage, "inputTokens")),
    outputTokens: addOptional(summary.outputTokens, numberField(usage, "outputTokens")),
    totalTokens: addOptional(summary.totalTokens, numberField(usage, "totalTokens")),
    cachedInputTokens: addOptional(summary.cachedInputTokens, numberField(usage, "cachedInputTokens")),
    cacheWriteTokens: addOptional(summary.cacheWriteTokens, numberField(usage, "cacheWriteTokens")),
    reasoningTokens: addOptional(summary.reasoningTokens, numberField(usage, "reasoningTokens")),
    turns: summary.turns + 1,
    contextWindow: numberField(usage, "contextWindow") ?? summary.contextWindow,
    lastInputTokens: numberField(usage, "inputTokens") ?? summary.lastInputTokens,
    tokenBudget: numberField(usage, "tokenBudget") ?? summary.tokenBudget,
    budgetExceeded: usage.budgetExceeded === true || summary.budgetExceeded,
    costUsd: addOptional(summary.costUsd, numberField(usage, "costUsd"))
  };
}

function addOptional(left?: number, right?: number): number | undefined {
  if (typeof left !== "number") return right;
  if (typeof right !== "number") return left;
  return left + right;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

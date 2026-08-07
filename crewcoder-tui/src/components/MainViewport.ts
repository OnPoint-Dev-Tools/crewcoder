import type { Component, KeyEvent, RenderContext, RenderedImagePlacement } from "../tui/component.js";
import type { TuiDeclarativeComponent, TuiEventBlock } from "../state/tui-store.js";
import type { TuiState } from "../state/tui-store.js";
import { bg, bold, fg, italic, reset, stripAnsi, visibleLength } from "../tui/ansi.js";
import { writeClipboard } from "../tui/clipboard.js";
import { emptyLine, padRight, splitLines, truncate, wrapText } from "../tui/layout.js";
import { spinnerFrame, renderSpinner } from "./Spinner.js";
import { renderMarkdown } from "./markdown-renderer.js";
import { renderExtensionUiErrorBlock } from "./ExtensionUiErrorBlock.js";
import { describeAttachment } from "../state/image-attachment.js";
import { detectImageProtocol, fitPlacement } from "../tui/image-protocol.js";

const TEXT_PADDING = 2;

type ViewportPoint = { row: number; col: number };
type ViewportImagePlacement = Omit<RenderedImagePlacement, "row" | "col"> & { lineIndex: number };

export class MainViewport implements Component {
  private visiblePlainLines: string[] = [];
  private selectionAnchor: ViewportPoint | undefined;
  private selectionFocus: ViewportPoint | undefined;
  private diffHunkLines: number[] = [];
  private activeDiffHunk = -1;
  private renderedLineCount = 0;
  /** Layout of the previous render; growth compensation is only valid when it is unchanged. */
  private lastLayout: { width: number; maxLines: number } | undefined;

  constructor(private readonly state: TuiState) {}

  render(ctx: RenderContext): string[] {
    const lines: string[] = [];
    const diffHunkLines: number[] = [];
    const transcriptStart = 0;
    const imagePlacements: ViewportImagePlacement[] = [];
    const maxLines = Math.max(1, ctx.size.height);

    for (const block of this.state.blocks) {
      if (lines.length > 0) lines.push(emptyLine(ctx.size.width));
      if (block.type === "system") renderSystem(lines, block.text, ctx);
      else if (block.type === "user") renderUser(lines, block, ctx);
      else if (block.type === "assistant") renderAssistant(lines, block, ctx);
      else if (block.type === "thinking") renderThinking(lines, block.text, ctx);
      else if (block.type === "compaction") renderCompaction(lines, block, ctx);
      else if (block.type === "review_summary") renderReviewSummary(lines, block, ctx);
      else if (block.type === "why") renderWhy(lines, block, ctx);
      else if (block.type === "goal") renderGoal(lines, block, ctx);
      else if (block.type === "crew") renderCrew(lines, block, ctx);
      else if (block.type === "checkpoint") renderCheckpoint(lines, block, ctx);
      else if (block.type === "checkpoint_diff") renderCheckpointDiff(lines, block, ctx);
      else if (block.type === "background_job") renderBackgroundJob(lines, block, ctx);
      else if (block.type === "tool") renderTool(lines, block, ctx, this.state.toolOutputExpanded, this.state.rendererHooks, diffHunkLines);
      else if (block.type === "validation") renderValidation(lines, block, ctx);
      else if (block.type === "approval") renderApproval(lines, block, ctx);
      else if (block.type === "extension_ui") renderExtensionUi(lines, block, ctx);
      else if (block.type === "image") renderImage(lines, block, ctx, imagePlacements);
      else if (block.type === "live_ui") renderLiveUi(lines, block, ctx, this.state.liveUiFrames);
      else if (block.type === "error") renderError(lines, block.text, ctx);
    }

    if (this.state.running) {
      if (lines.length > 0) lines.push(emptyLine(ctx.size.width));
      renderWorkingIndicator(lines, ctx);
    }

    // `viewportScroll` is an offset from the bottom, so a live run that keeps
    // appending lines would drag scrolled-back content out from under the reader.
    // While the user is scrolled up, absorb the growth so the same content stays
    // put; at the bottom (scroll 0) the transcript still follows the stream.
    const growth = lines.length - this.renderedLineCount;
    const layoutUnchanged = this.lastLayout?.width === ctx.size.width && this.lastLayout?.maxLines === maxLines;
    if (this.state.viewportScroll > 0 && growth > 0 && layoutUnchanged) this.state.viewportScroll += growth;

    this.diffHunkLines = diffHunkLines;
    this.renderedLineCount = lines.length;
    this.lastLayout = { width: ctx.size.width, maxLines };
    if (this.activeDiffHunk >= diffHunkLines.length) this.activeDiffHunk = diffHunkLines.length - 1;
    const maxScroll = Math.max(0, lines.length - maxLines);
    this.state.viewportHeight = maxLines;
    this.state.viewportMaxScroll = maxScroll;
    this.state.viewportScroll = Math.max(0, Math.min(this.state.viewportScroll, maxScroll));
    const end = lines.length - this.state.viewportScroll;
    const start = Math.max(0, end - maxLines);
    const result = lines.slice(start, end);
    const shortContentPadding = Math.max(0, maxLines - result.length);
    if (shortContentPadding > 0) {
      result.splice(transcriptStart, 0, ...Array.from({ length: shortContentPadding }, () => emptyLine(ctx.size.width)));
    }

    const visibleEnd = end + shortContentPadding;
    const visibleImagePlacements = imagePlacements.flatMap((image) => {
      const lineIndex = image.lineIndex >= transcriptStart ? image.lineIndex + shortContentPadding : image.lineIndex;
      if (lineIndex < start || lineIndex + image.placement.rows > visibleEnd) return [];
      return [{
        id: image.id,
        row: lineIndex - start + 1,
        col: TEXT_PADDING + 1,
        protocol: image.protocol,
        attachment: image.attachment,
        placement: image.placement
      }];
    });
    if (ctx.imagePlacements) ctx.imagePlacements.push(...visibleImagePlacements);
    else ctx.imagePlacements = visibleImagePlacements;

    this.visiblePlainLines = result.map(stripAnsi);
    const rendered = result.map((line, row) => this.renderSelection(line, row, ctx.theme.selectedBg));
    return renderScrollbarPill(rendered, this.state.viewportScroll, maxScroll, ctx.size.width, ctx.theme.muted);
  }

  jumpDiffHunk(direction: "next" | "previous"): boolean {
    if (!this.diffHunkLines.length) return false;
        if (direction === "next") this.activeDiffHunk = (this.activeDiffHunk + 1 + this.diffHunkLines.length) % this.diffHunkLines.length;
        else this.activeDiffHunk = (this.activeDiffHunk - 1 + this.diffHunkLines.length) % this.diffHunkLines.length;
        const target = this.diffHunkLines[this.activeDiffHunk]!;
        const desiredStart = Math.max(0, target - Math.max(1, Math.floor(this.state.viewportHeight / 2)));
        this.state.viewportScroll = Math.max(0, this.renderedLineCount - this.state.viewportHeight - desiredStart);
        return true;
  }

  handleMouse(event: KeyEvent, topRow: number, copy: (text: string) => boolean = writeClipboard, onCopied?: () => void): boolean {
    if (event.name !== "mouse" || !event.mouse) return false;
    const point = this.pointFromMouse(event.mouse.x, event.mouse.y - topRow);
    if (!point) return false;
    if (event.mouse.kind === "press") {
      this.selectionAnchor = point;
      this.selectionFocus = point;
      return true;
    }
    if (event.mouse.kind === "drag") {
      this.selectionFocus = point;
      return true;
    }
    if (event.mouse.kind === "release") {
      this.selectionFocus = point;
      const selected = this.selectedText();
      if (selected && copy(selected)) {
        this.clearSelection();
        onCopied?.();
      }
      return true;
    }
    return false;
  }

  private pointFromMouse(x: number, row: number): ViewportPoint | undefined {
    const zeroRow = row;
    const line = this.visiblePlainLines[zeroRow];
    if (line === undefined) return undefined;
    const col = Math.max(0, Math.min(line.length, x - 1));
    return { row: zeroRow, col };
  }

  private selectedText(): string {
    const range = this.selectionRange();
    if (!range) return "";
    const selected: string[] = [];
    for (let row = range.start.row; row <= range.end.row; row++) {
      const line = this.visiblePlainLines[row] ?? "";
      const start = row === range.start.row ? range.start.col : 0;
      const end = row === range.end.row ? range.end.col : line.length;
      selected.push(line.slice(start, end).trimEnd());
    }
    return selected.join("\n").trim();
  }

  private renderSelection(line: string, row: number, selectedBg: string): string {
    const range = this.selectionRange();
    const plain = this.visiblePlainLines[row] ?? "";
    if (!range || row < range.start.row || row > range.end.row) return line;
    const start = row === range.start.row ? range.start.col : 0;
    const end = row === range.end.row ? range.end.col : plain.length;
    if (end <= start) return line;
    return `${plain.slice(0, start)}${bg(selectedBg)}${plain.slice(start, end)}${reset()}${plain.slice(end)}`;
  }

  private selectionRange(): { start: ViewportPoint; end: ViewportPoint } | undefined {
    if (!this.selectionAnchor || !this.selectionFocus) return undefined;
    const a = this.selectionAnchor;
    const b = this.selectionFocus;
    if (a.row === b.row && a.col === b.col) return undefined;
    if (a.row < b.row || (a.row === b.row && a.col < b.col)) return { start: a, end: b };
    return { start: b, end: a };
  }

  private clearSelection(): void {
    this.selectionAnchor = undefined;
    this.selectionFocus = undefined;
  }
}

/**
 * Single-line working indicator.
 *
 * This used to be a 3x3 spinner mosaic plus two captions and surrounding blank
 * lines — 8 rows of transcript for one bit of information, on every frame of a
 * long run. Since the bottom `RuntimeBar` chrome was removed, this line is the
 * only running indicator, so keep it (and keep it one line).
 */
function renderScrollbarPill(lines: string[], viewportScroll: number, maxScroll: number, width: number, color: string): string[] {
  if (maxScroll <= 0 || lines.length === 0 || width <= 0) return lines;
  const pillHeight = Math.min(2, lines.length);
  const travel = Math.max(0, lines.length - pillHeight);
  // viewportScroll is measured from the bottom, while the pill travels top-to-bottom.
  const progressFromTop = (maxScroll - viewportScroll) / maxScroll;
  const pillStart = Math.round(progressFromTop * travel);
  return lines.map((line, row) => row >= pillStart && row < pillStart + pillHeight
    ? replaceFinalVisibleCell(padRight(line, width), `${fg(color)}▐${reset()}`)
    : line);
}

function replaceFinalVisibleCell(line: string, replacement: string): string {
  const tokens = line.match(/\x1b\[[0-9;?]*[A-Za-z]|./gsu) ?? [];
  for (let index = tokens.length - 1; index >= 0; index--) {
    if (tokens[index]?.startsWith("\x1b[")) continue;
    tokens[index] = `${reset()}${replacement}`;
    break;
  }
  return tokens.join("");
}

function renderWorkingIndicator(lines: string[], ctx: RenderContext): void {
  const label = `${fg(ctx.theme.accent)}${bold()}${spinnerFrame()}${reset()} ${fg(ctx.theme.text)}${bold()}AGENT IS WORKING${reset()} ${fg(ctx.theme.muted)}· Esc to abort${reset()}`;
  lines.push(padRight(`${" ".repeat(TEXT_PADDING)}${label}`, ctx.size.width));
}

function renderSystem(lines: string[], text: string, ctx: RenderContext): void {
  lines.push(backgroundLine("", ctx.size.width, ctx.theme.panel));
  lines.push(backgroundLine(`${fg(ctx.theme.accent3)}${bold()}SYSTEM${reset()}`, ctx.size.width, ctx.theme.panel));
  for (const line of wrapText(text, textWidth(ctx, 3))) {
    lines.push(backgroundLine(`${fg(ctx.theme.success)}▌${reset()} ${fg(ctx.theme.text)}${italic()}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
  lines.push(backgroundLine("", ctx.size.width, ctx.theme.panel));
}

function renderUser(lines: string[], block: Extract<TuiEventBlock, { type: "user" }>, ctx: RenderContext): void {
  lines.push(backgroundLine("", ctx.size.width, ctx.theme.panel));
  for (const line of wrapText(block.text, textWidth(ctx, 4))) {
    lines.push(backgroundLine(`${fg(ctx.theme.accent)}▌${reset()} ${fg(ctx.theme.text)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
  if (block.background?.length) {
    lines.push(backgroundLine(`${fg(ctx.theme.accent2)}${bold()}BACKGROUND${reset()} ${fg(ctx.theme.muted)}attached to user turn${reset()}`, ctx.size.width, ctx.theme.panel));
    for (const item of block.background) {
      for (const line of wrapText(item, textWidth(ctx, 4))) {
        lines.push(backgroundLine(`${fg(ctx.theme.muted)}  ${line}${reset()}`, ctx.size.width, ctx.theme.panel));
      }
    }
  }
  lines.push(backgroundLine("", ctx.size.width, ctx.theme.panel));
}

function renderAssistant(lines: string[], block: Extract<TuiEventBlock, { type: "assistant" }>, ctx: RenderContext): void {
  const rate = typeof block.tokensPerSecond === "number" && Number.isFinite(block.tokensPerSecond)
    ? ` ${fg(ctx.theme.muted)}${formatTokensPerSecond(block.tokensPerSecond)} tok/s${reset()}`
    : "";
  lines.push(padRight(padded(`${fg(ctx.theme.success)}${bold()}CREW CODER${reset()}${rate}`), ctx.size.width));
  for (const line of renderMarkdown(block.text, textWidth(ctx, 4), ctx)) {
    lines.push(padRight(padded(`${fg(ctx.theme.text)}${line.text}${reset()}`), ctx.size.width));
  }
}

function formatTokensPerSecond(rate: number): string {
  if (rate >= 100) return Math.round(rate).toLocaleString("en-US");
  return rate.toFixed(1);
}

function renderThinking(lines: string[], text: string, ctx: RenderContext): void {
  const trimmed = text.trimEnd();
  if (!trimmed) return;
  lines.push(blockPaddingLine(ctx, ctx.theme.panelThinking));
  lines.push(backgroundLine(`${fg(ctx.theme.accent2)}${bold()}THOUGHTS...${reset()} ${fg(ctx.theme.muted)}${reset()}`, ctx.size.width, ctx.theme.panelThinking));
  for (const line of wrapText(trimmed, textWidth(ctx, 4))) {
    lines.push(backgroundLine(`${fg(ctx.theme.accent2)}▌${reset()} ${fg(ctx.theme.muted)}${italic()}${line}${reset()}`, ctx.size.width, ctx.theme.panelThinking));
  }
  lines.push(blockPaddingLine(ctx, ctx.theme.panelThinking));
}

function renderCompaction(lines: string[], block: Extract<TuiEventBlock, { type: "compaction" }>, ctx: RenderContext): void {
  const statusColor = block.status === "failed" ? ctx.theme.danger : block.status === "done" ? ctx.theme.success : block.status === "skipped" ? ctx.theme.warning : ctx.theme.accent;
  const label = block.status === "done" ? "COMPACTION COMPLETE" : block.status === "skipped" ? "COMPACTION SKIPPED" : block.status === "failed" ? "COMPACTION FAILED" : "COMPACTING SESSION";
  const spinner = block.status === "running" ? `${renderSpinner(ctx.theme.accent)} ` : "";
  const counts = typeof block.originalMessageCount === "number" && typeof block.retainedMessageCount === "number"
    ? ` ${block.originalMessageCount} → ${block.retainedMessageCount} messages`
    : "";
  lines.push(backgroundLine(`${spinner}${fg(statusColor)}${bold()}${label}${reset()}${fg(ctx.theme.muted)}${counts}${reset()}`, ctx.size.width, ctx.theme.panel));
  lines.push(backgroundLine(`${renderProgressBar(block.percent, Math.max(10, textWidth(ctx, 4)), statusColor, ctx.theme.muted)} ${fg(ctx.theme.text)}${Math.round(block.percent)}%${reset()}`, ctx.size.width, ctx.theme.panel));
  for (const line of wrapText(block.message, textWidth(ctx, 4))) {
    lines.push(backgroundLine(`${fg(ctx.theme.muted)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
}

function renderReviewSummary(lines: string[], block: Extract<TuiEventBlock, { type: "review_summary" }>, ctx: RenderContext): void {
  const summary = block.summary;
  const statusColor = summary.clean ? ctx.theme.success : ctx.theme.warning;
  const status = summary.clean ? "clean" : "dirty";
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
  lines.push(backgroundLine(`${fg(ctx.theme.accent2)}${bold()}REVIEW SUMMARY${reset()} ${fg(ctx.theme.text)}${summary.branch ?? "(no branch)"}${reset()} ${fg(statusColor)}${status}${reset()}`, ctx.size.width, ctx.theme.panel));
  lines.push(backgroundLine(`${fg(ctx.theme.muted)}${summary.changedFiles.length} changed file${summary.changedFiles.length === 1 ? "" : "s"} · ${summary.issueReferences.length} issue reference${summary.issueReferences.length === 1 ? "" : "s"}${reset()}`, ctx.size.width, ctx.theme.panel));
  if (summary.changedFiles.length) {
    lines.push(backgroundLine(`${fg(ctx.theme.success)}files${reset()}`, ctx.size.width, ctx.theme.panel));
    for (const file of summary.changedFiles.slice(0, 8)) {
      lines.push(backgroundLine(`${fg(ctx.theme.success)}•${reset()} ${fg(ctx.theme.text)}${truncate(file, textWidth(ctx, 4))}${reset()}`, ctx.size.width, ctx.theme.panel));
    }
    if (summary.changedFiles.length > 8) lines.push(backgroundLine(`${fg(ctx.theme.muted)}… ${summary.changedFiles.length - 8} more${reset()}`, ctx.size.width, ctx.theme.panel));
  }
  if (summary.issueReferences.length) {
    lines.push(backgroundLine(`${fg(ctx.theme.accent3)}issues${reset()}`, ctx.size.width, ctx.theme.panel));
    for (const issue of summary.issueReferences.slice(0, 6)) {
      const source = `${issue.text} (${issue.source})`;
      const url = issue.url ? ` ${issue.url}` : "";
      for (const line of wrapText(`${source}${url}`, textWidth(ctx, 4))) {
        lines.push(backgroundLine(`${fg(ctx.theme.accent3)}#${reset()} ${fg(ctx.theme.text)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
      }
    }
    if (summary.issueReferences.length > 6) lines.push(backgroundLine(`${fg(ctx.theme.muted)}… ${summary.issueReferences.length - 6} more${reset()}`, ctx.size.width, ctx.theme.panel));
  } else {
    lines.push(backgroundLine(`${fg(ctx.theme.muted)}No issue references found in branch, recent commits, or git status.${reset()}`, ctx.size.width, ctx.theme.panel));
  }
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
}

/**
 * `/why` output. The source badge is not decoration: a `transcript` explanation
 * is a deterministic readout of what happened, not the model's reasoning, and
 * the two must never look identical.
 */
function renderWhy(lines: string[], block: Extract<TuiEventBlock, { type: "why" }>, ctx: RenderContext): void {
  const decision = block.decision;
  const fromModel = decision.source === "model";
  const badgeColor = fromModel ? ctx.theme.success : ctx.theme.warning;
  const badge = fromModel ? "model explanation" : "transcript readout";
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
  lines.push(backgroundLine(`${fg(ctx.theme.accent2)}${bold()}WHY${reset()} ${fg(ctx.theme.muted)}last decision${reset()} ${fg(badgeColor)}${badge}${reset()}`, ctx.size.width, ctx.theme.panel));
  if (decision.fallbackReason) {
    for (const line of wrapText(`The model explainer was not used: ${decision.fallbackReason}`, textWidth(ctx, 4))) {
      lines.push(backgroundLine(`${fg(ctx.theme.warning)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
    }
  }
  for (const line of wrapText(decision.explanation, textWidth(ctx, 4))) {
    lines.push(backgroundLine(`${fg(ctx.theme.text)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
  if (decision.toolCalls.length) {
    lines.push(backgroundLine(`${fg(ctx.theme.muted)}tools: ${truncate(decision.toolCalls.join(", "), textWidth(ctx, 11))}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
  if (decision.changedFiles.length) {
    lines.push(backgroundLine(`${fg(ctx.theme.muted)}files: ${truncate(decision.changedFiles.join(", "), textWidth(ctx, 11))}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
}

function renderCrew(lines: string[], block: Extract<TuiEventBlock, { type: "crew" }>, ctx: RenderContext): void {
  const running = block.workers.filter((worker) => worker.status === "running").length;
  const failed = block.workers.filter((worker) => worker.status === "failed").length;
  const heading = block.completed ? "CREW COMPLETE" : "CREW RUNNING";
  const headingColor = failed ? ctx.theme.danger : block.completed ? ctx.theme.success : ctx.theme.accent;
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
  lines.push(backgroundLine(`${block.completed ? "" : `${renderSpinner(ctx.theme.accent)} `}${fg(headingColor)}${bold()}${heading}${reset()} ${fg(ctx.theme.muted)}${block.workers.length} agent${block.workers.length === 1 ? "" : "s"}${running ? ` · ${running} active` : ""}${reset()}`, ctx.size.width, ctx.theme.panel));
  for (const worker of block.workers) {
    const marker = worker.status === "running" ? renderSpinner(ctx.theme.accent) : worker.status === "completed" ? "✓" : worker.status === "failed" ? "×" : "○";
    const color = worker.status === "failed" ? ctx.theme.danger : worker.status === "completed" ? ctx.theme.success : worker.status === "running" ? ctx.theme.accent : ctx.theme.muted;
    const detail = worker.error ?? worker.sessionId;
    lines.push(backgroundLine(`${fg(color)}${marker} ${worker.name}${reset()}${detail ? ` ${fg(ctx.theme.muted)}${truncate(detail, textWidth(ctx, worker.name.length + 6))}${reset()}` : ""}`, ctx.size.width, ctx.theme.panel));
  }
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
}

function renderGoal(lines: string[], block: Extract<TuiEventBlock, { type: "goal" }>, ctx: RenderContext): void {
  const goal = block.goal;
  const statusColor = goal.status === "completed" ? ctx.theme.success
    : goal.status === "failed" || goal.status === "cancelled" ? ctx.theme.danger
      : goal.status === "paused" || goal.status === "awaiting_approval" ? ctx.theme.warning
        : ctx.theme.accent;
  const marker = goal.status === "running" || goal.status === "queued" ? `${renderSpinner(statusColor)} ` : "";
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
  lines.push(backgroundLine(`${marker}${fg(statusColor)}${bold()}GOAL ${goal.status.toUpperCase()}${reset()} ${fg(ctx.theme.muted)}${goal.id} · cycle ${goal.cycle}${goal.maxTurns ? `/${goal.maxTurns}` : ""}${reset()}`, ctx.size.width, ctx.theme.panel));
  for (const line of wrapText(goal.objective, textWidth(ctx, 4))) lines.push(backgroundLine(`${fg(ctx.theme.text)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  lines.push(backgroundLine(`${fg(ctx.theme.muted)}maker ${goal.provider}/${goal.model}${goal.sessionId ? ` · session ${goal.sessionId}` : ""}${reset()}`, ctx.size.width, ctx.theme.panel));
  if (goal.checkModel) lines.push(backgroundLine(`${fg(ctx.theme.accent2)}verifier ${goal.provider}/${goal.checkModel}${reset()}${fg(ctx.theme.muted)}${goal.timeoutMinutes ? ` · timeout ${goal.timeoutMinutes}m` : ""}${reset()}`, ctx.size.width, ctx.theme.panel));
  if (goal.lastCheck) {
    const checkColor = goal.lastCheck.verdict === "complete" ? ctx.theme.success : ctx.theme.warning;
    for (const line of wrapText(`Last check: ${goal.lastCheck.verdict} — ${goal.lastCheck.reason}`, textWidth(ctx, 4))) lines.push(backgroundLine(`${fg(checkColor)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
  if (goal.pendingApproval) {
    for (const line of wrapText(`Approval required for ${goal.pendingApproval.toolName}: ${goal.pendingApproval.reason}`, textWidth(ctx, 4))) lines.push(backgroundLine(`${fg(ctx.theme.warning)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
    lines.push(backgroundLine(`${fg(ctx.theme.success)}/goal approve${reset()} ${fg(ctx.theme.muted)}or${reset()} ${fg(ctx.theme.danger)}/goal deny${reset()}`, ctx.size.width, ctx.theme.panel));
  }
  const detail = goal.completionSummary ?? goal.pauseReason ?? goal.error;
  if (detail) for (const line of wrapText(detail, textWidth(ctx, 4))) lines.push(backgroundLine(`${fg(statusColor)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  if (goal.completionEvidence) for (const line of wrapText(`Evidence: ${goal.completionEvidence}`, textWidth(ctx, 4))) lines.push(backgroundLine(`${fg(ctx.theme.subtle)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
}

function renderCheckpoint(lines: string[], block: Extract<TuiEventBlock, { type: "checkpoint" }>, ctx: RenderContext): void {
  const truncated = block.truncated ? ` ${fg(ctx.theme.warning)}truncated${reset()}` : "";
  const tool = block.toolName ? ` before ${block.toolName}` : "";
  lines.push(backgroundLine(`${fg(ctx.theme.accent2)}${bold()}checkpoint${reset()} ${fg(ctx.theme.text)}${block.checkpointId}${reset()}${fg(ctx.theme.muted)}${tool} · ${block.fileCount} files · ${formatBytes(block.totalBytes)}${reset()}${truncated}`, ctx.size.width, ctx.theme.panel));
  for (const line of wrapText(`rewind: /rewind ${block.checkpointId} · ${block.reason}`, textWidth(ctx, 2))) {
    lines.push(backgroundLine(`${fg(ctx.theme.subtle)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
}

function renderCheckpointDiff(lines: string[], block: Extract<TuiEventBlock, { type: "checkpoint_diff" }>, ctx: RenderContext): void {
  const title = `diff ${block.path}${block.truncated ? " (truncated)" : ""}`;
  lines.push(backgroundLine(`${fg(ctx.theme.accent2)}${bold()}checkpoint diff${reset()} ${fg(ctx.theme.text)}${title}${reset()} ${fg(ctx.theme.muted)}${block.checkpointId}${reset()}`, ctx.size.width, ctx.theme.panel));
  const width = Math.max(12, Math.floor((textWidth(ctx, 4) - 3) / 2));
  for (let index = 0; index < block.lines.length; index += 2) {
    const left = block.lines[index]?.startsWith("-") ? block.lines[index] ?? "" : "";
    const right = block.lines[index + 1]?.startsWith("+") ? block.lines[index + 1] ?? "" : block.lines[index]?.startsWith("+") ? block.lines[index] ?? "" : "";
    const leftText = truncate(left.replace(/^-/, ""), width).padEnd(width);
    const rightText = truncate(right.replace(/^\+/, ""), width).padEnd(width);
    lines.push(backgroundLine(`${fg(ctx.theme.danger)}-${leftText}${reset()} ${fg(ctx.theme.muted)}│${reset()} ${fg(ctx.theme.success)}+${rightText}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderProgressBar(percent: number, width: number, fillColor: string, emptyColor: string): string {
  const bounded = Math.max(0, Math.min(100, percent));
  const barWidth = Math.max(8, Math.min(32, width - 6));
  const filled = Math.round((bounded / 100) * barWidth);
  return `${fg(fillColor)}${"█".repeat(filled)}${fg(emptyColor)}${"░".repeat(Math.max(0, barWidth - filled))}${reset()}`;
}

function renderBackgroundJob(lines: string[], block: Extract<TuiEventBlock, { type: "background_job" }>, ctx: RenderContext): void {
  const color = block.status === "running" ? ctx.theme.warning : block.status === "completed" ? ctx.theme.success : ctx.theme.danger;
  const marker = block.status === "running" ? `${renderSpinner(ctx.theme.warning)} ` : `${fg(color)}◆${reset()} `;
  const exit = block.exitCode === undefined ? "" : ` · exit ${String(block.exitCode)}`;
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
  lines.push(backgroundLine(`${marker}${fg(color)}${bold()}BACKGROUND ${block.status.toUpperCase()}${reset()} ${fg(ctx.theme.accent2)}${block.bgId}${reset()}${fg(ctx.theme.muted)}${exit}${reset()}`, ctx.size.width, ctx.theme.panel));
  for (const line of wrapText(block.command, textWidth(ctx, 4))) lines.push(backgroundLine(`${fg(ctx.theme.text)}❯ ${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  const output = splitLines(block.output.trim()).slice(-8);
  for (const line of output) lines.push(backgroundLine(`${fg(ctx.theme.subtle)}│${reset()} ${fg(ctx.theme.text)}${truncate(line, 140)}${reset()}`, ctx.size.width, ctx.theme.panel));
  if (!output.length) lines.push(backgroundLine(`${fg(ctx.theme.muted)}(waiting for output)${reset()}`, ctx.size.width, ctx.theme.panel));
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
}

export function toolHasExpandableOutput(block: Extract<TuiEventBlock, { type: "tool" }>, renderers: TuiState["rendererHooks"] = []): boolean {
  return !findToolRenderer(block, renderers) && !toolDiff(block) && toolBody(block).length > 10;
}

function renderTool(lines: string[], block: Extract<TuiEventBlock, { type: "tool" }>, ctx: RenderContext, expanded: boolean, renderers: TuiState["rendererHooks"] = [], diffHunkLines: number[] = []): void {
  const renderer = findToolRenderer(block, renderers);
  if (renderer) {
    renderCustomTool(lines, block, renderer, ctx);
    return;
  }
  const action = toolDisplayLabel(block);
  const icon = toolDisplayIcon(block);
  const filePath = toolFilePath(block.args);
  const detail = toolDetail(block.name, block.args);
  const suffix = block.status === "running" ? " running" : block.status === "error" ? " failed" : "";
  const marker = block.status === "running" ? `${renderSpinner(ctx.theme.warning)} ` : `${fg(ctx.theme.accent)}${icon}${reset()} `;
  const detailSegment = renderToolDetailSegment(detail, filePath, ctx.theme.muted, ctx);
  const category = typeof block.metadata?.category === "string" && block.metadata.category.trim() ? ` ${fg(ctx.theme.muted)}${block.metadata.category}${reset()}` : "";
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
  lines.push(backgroundLine(`${marker}${fg(ctx.theme.muted)}${bold()}TOOL: ${action.toUpperCase()}${reset()}${category} ${detailSegment}${fg(ctx.theme.muted)}${suffix}${reset()}`, ctx.size.width, ctx.theme.panel));

  const diff = toolDiff(block);
  if (diff) {
    renderSideBySideDiff(lines, diff, ctx, diffHunkLines);
    lines.push(blockPaddingLine(ctx, ctx.theme.panel));
    return;
  }
  const body = toolBody(block);
  const visibleBody = expanded ? body : body.slice(0, 10);
  for (const line of visibleBody) lines.push(renderToolBodyLine(line, ctx));
  if (!expanded && body.length > 10) lines.push(backgroundLine(`${fg(ctx.theme.success)}... (${body.length - 10} more lines, ctrl+o to expand)${reset()}`, ctx.size.width, ctx.theme.panel));
  if (expanded && body.length > 10) lines.push(backgroundLine(`${fg(ctx.theme.muted)}expanded · ctrl+o to collapse${reset()}`, ctx.size.width, ctx.theme.panel));
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
}

function renderCustomTool(lines: string[], block: Extract<TuiEventBlock, { type: "tool" }>, renderer: TuiState["rendererHooks"][number], ctx: RenderContext): void {
  const statusColor = block.status === "error" ? ctx.theme.danger : block.status === "done" ? ctx.theme.success : ctx.theme.warning;
  const suffix = block.status === "running" ? " running" : block.status === "error" ? " failed" : "";
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
  lines.push(backgroundLine(`${fg(statusColor)}${bold()}${renderer.title.toUpperCase()}${reset()} ${fg(ctx.theme.muted)}[${renderer.extensionId}:${renderer.id}]${suffix}${reset()}`, ctx.size.width, ctx.theme.panel));
  const rendered = renderTemplate(renderer.template, block);
  for (const line of renderMarkdown(rendered, textWidth(ctx, 4), ctx)) {
    lines.push(backgroundLine(`${fg(ctx.theme.text)}${line.text}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
}

function findToolRenderer(block: Extract<TuiEventBlock, { type: "tool" }>, renderers: TuiState["rendererHooks"]): TuiState["rendererHooks"][number] | undefined {
  return renderers.find((renderer) => renderer.target === "tool" && rendererMatchesTool(renderer.match, block));
}

function rendererMatchesTool(match: TuiState["rendererHooks"][number]["match"], block: Extract<TuiEventBlock, { type: "tool" }>): boolean {
  const metadata = block.metadata ?? {};
  if (match.extensionId !== undefined && metadata.extensionId !== match.extensionId) return false;
  if (match.toolId !== undefined && metadata.toolId !== match.toolId) return false;
  if (match.renderer !== undefined && metadata.renderer !== match.renderer) return false;
  if (match.toolName !== undefined && block.name !== match.toolName) return false;
  return true;
}

function renderTemplate(template: string, block: Extract<TuiEventBlock, { type: "tool" }>): string {
  return template.replaceAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_placeholder, rawPath: string) => templateValue(rawPath, block));
}

function templateValue(path: string, block: Extract<TuiEventBlock, { type: "tool" }>): string {
  if (path === "name") return block.name;
  if (path === "status") return block.status;
  if (path === "text") return block.text ?? "";
  if (path.startsWith("metadata.")) return stringifyTemplateValue(nestedValue(block.metadata, path.slice("metadata.".length)));
  if (path.startsWith("args.")) return stringifyTemplateValue(nestedValue(block.args, path.slice("args.".length)));
  return "";
}

function nestedValue(record: Record<string, unknown> | undefined, path: string): unknown {
  if (!record) return undefined;
  let current: unknown = record;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function renderToolBodyLine(line: ToolBodyLine, ctx: RenderContext): string {
  if (line.kind === "add") {
    return backgroundLine(`${fg(ctx.theme.success)}${bold()}+${reset()} ${fg(ctx.theme.success)}${line.text}${reset()}`, ctx.size.width, ctx.theme.diffAddBg);
  }
  if (line.kind === "del") {
    return backgroundLine(`${fg(ctx.theme.danger)}${bold()}-${reset()} ${fg(ctx.theme.danger)}${line.text}${reset()}`, ctx.size.width, ctx.theme.diffDelBg);
  }
  return backgroundLine(`${fg(ctx.theme.muted)}│${reset()} ${highlightToolOutputLine(line.text, ctx)}`, ctx.size.width, ctx.theme.panel);
}

function highlightToolOutputLine(text: string, ctx: RenderContext): string {
  if (!text) return `${fg(ctx.theme.muted)}${text}${reset()}`;
  const commentStart = text.search(/\/\/|#/);
  const code = commentStart >= 0 ? text.slice(0, commentStart) : text;
  const comment = commentStart >= 0 ? text.slice(commentStart) : "";
  const highlighted = code.replace(/("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`|\b(?:const|let|var|function|return|if|else|for|while|import|from|export|type|interface|class|extends|async|await|new|try|catch|throw)\b|\b(?:true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b|(?:\.?\.?\/[\w./-]+|[\w.-]+\/[\w./-]+))/g, (token) => {
    if (/^["'`]/.test(token)) return `${fg(ctx.theme.success)}${token}${reset()}${fg(ctx.theme.muted)}`;
    if (/^\d/.test(token)) return `${fg(ctx.theme.accent3)}${token}${reset()}${fg(ctx.theme.muted)}`;
    if (/^(true|false|null|undefined)$/.test(token)) return `${fg(ctx.theme.accent3)}${token}${reset()}${fg(ctx.theme.muted)}`;
    if (token.includes("/")) return `${fg(ctx.theme.accent2)}${token}${reset()}${fg(ctx.theme.muted)}`;
    return `${fg(ctx.theme.warning)}${token}${reset()}${fg(ctx.theme.muted)}`;
  });
  const commentSegment = comment ? `${fg(ctx.theme.muted)}${italic()}${comment}${reset()}` : "";
  return `${fg(ctx.theme.muted)}${highlighted}${reset()}${commentSegment}`;
}

function renderApproval(lines: string[], block: Extract<TuiEventBlock, { type: "approval" }>, ctx: RenderContext): void {
  const riskColor = block.status === "denied" ? ctx.theme.danger : block.status === "approved" ? ctx.theme.success : block.risk === "dangerous" ? ctx.theme.danger : ctx.theme.warning;
  const label = block.status === "pending" ? "approval required" : block.status === "approved" ? "approval approved" : "approval denied";
  lines.push(backgroundLine(`${fg(riskColor)}${bold()}${label}${reset()} ${fg(ctx.theme.warning)}${block.toolName ?? "tool"}${reset()} ${fg(ctx.theme.muted)}${block.risk ?? "review"}${reset()}`, ctx.size.width, ctx.theme.panel));
  for (const line of wrapText(block.text, textWidth(ctx, 2))) lines.push(backgroundLine(`${fg(ctx.theme.text)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  const args = formatArgs(block.args);
  if (args) lines.push(backgroundLine(`${fg(ctx.theme.muted)}${args}${reset()}`, ctx.size.width, ctx.theme.panel));
  if (block.status === "pending") {
    const target = block.id ? ` ${block.id}` : "";
    lines.push(backgroundLine(`${fg(ctx.theme.success)}approve:${reset()} ${fg(ctx.theme.text)}/approve${target}${reset()} ${fg(ctx.theme.danger)}deny:${reset()} ${fg(ctx.theme.text)}/deny${target}${reset()}`, ctx.size.width, ctx.theme.panel));
  } else if (block.resolutionReason) {
    for (const line of wrapText(block.resolutionReason, textWidth(ctx, 2))) lines.push(backgroundLine(`${fg(ctx.theme.muted)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
}

function renderExtensionUi(lines: string[], block: Extract<TuiEventBlock, { type: "extension_ui" }>, ctx: RenderContext): void {
  try {
    const statusColor = block.status === "cancelled" ? ctx.theme.danger : block.status === "answered" ? ctx.theme.success : ctx.theme.warning;
    const label = block.status === "pending" ? "input requested" : block.status === "answered" ? "input answered" : "input cancelled";
    lines.push(backgroundLine(`${fg(statusColor)}${bold()}${label}${reset()} ${fg(ctx.theme.muted)}[${block.extensionId}] ${block.uiKind}${reset()}`, ctx.size.width, ctx.theme.panel));
    for (const line of wrapText(block.title, textWidth(ctx, 2))) lines.push(backgroundLine(`${fg(ctx.theme.text)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
    if (block.message) {
      for (const line of wrapText(block.message, textWidth(ctx, 2))) lines.push(backgroundLine(`${fg(ctx.theme.muted)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
    }
    if (block.component) {
      if (block.component.kind === "table") renderTableComponent(lines, block.component, ctx);
      else for (const line of wrapText(componentSummary(block.component), textWidth(ctx, 2))) lines.push(backgroundLine(`${fg(ctx.theme.subtle)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
    }
    if (block.status === "answered" && block.answer !== undefined) {
      for (const line of wrapText(`→ ${block.answer}`, textWidth(ctx, 2))) lines.push(backgroundLine(`${fg(ctx.theme.success)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
    }
  } catch (error) {
    lines.push(...renderExtensionUiErrorBlock(ctx, block.extensionId, error));
  }
}

function componentSummary(component: NonNullable<Extract<TuiEventBlock, { type: "extension_ui" }>["component"]>): string {
  if (component.kind === "markdown") return component.text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "markdown component";
  if (component.kind === "details") return `${component.items.length} detail${component.items.length === 1 ? "" : "s"}`;
  if (component.kind === "table") return `${component.rows.length} row${component.rows.length === 1 ? "" : "s"} · ${component.columns.length} column${component.columns.length === 1 ? "" : "s"}`;
  return `${component.actions.length} action${component.actions.length === 1 ? "" : "s"}`;
}

const MAX_TABLE_ROWS = 50;
const TABLE_CELL_SEPARATOR = " │ ";
const TABLE_MIN_COLUMN_WIDTH = 3;

function formatTableCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function resolveTableColumnWidths(table: Extract<TuiDeclarativeComponent, { kind: "table" }>, available: number): number[] {
  const overhead = (table.columns.length - 1) * visibleLength(TABLE_CELL_SEPARATOR);
  const widths = table.columns.map((column) => {
    let width = visibleLength(column.label);
    for (const row of table.rows) width = Math.max(width, visibleLength(formatTableCell(row[column.key])));
    return Math.max(1, width);
  });
  const naturalTotal = widths.reduce((sum, width) => sum + width, 0);
  if (naturalTotal + overhead <= available) return widths;

  const budget = Math.max(table.columns.length * TABLE_MIN_COLUMN_WIDTH, available - overhead);
  const scaled = widths.map((width) => Math.max(TABLE_MIN_COLUMN_WIDTH, Math.floor((width / naturalTotal) * budget)));
  let overflow = scaled.reduce((sum, width) => sum + width, 0) + overhead - available;
  while (overflow > 0) {
    const widest = scaled.indexOf(Math.max(...scaled));
    if (scaled[widest] <= TABLE_MIN_COLUMN_WIDTH) break;
    scaled[widest] -= 1;
    overflow -= 1;
  }
  return scaled;
}

function renderTableComponent(lines: string[], table: Extract<TuiDeclarativeComponent, { kind: "table" }>, ctx: RenderContext): void {
  if (table.columns.length === 0 || table.rows.length === 0) {
    for (const line of wrapText(componentSummary(table), textWidth(ctx, 2))) lines.push(backgroundLine(`${fg(ctx.theme.subtle)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
    return;
  }
  const widths = resolveTableColumnWidths(table, textWidth(ctx, 2));
  const separator = `${fg(ctx.theme.subtle)}${TABLE_CELL_SEPARATOR}${reset()}`;
  const renderRow = (cells: string[], color: string, emphasize: boolean): string =>
    cells
      .map((cell, index) => `${emphasize ? bold() : ""}${fg(color)}${padRight(truncate(cell, widths[index]), widths[index])}${reset()}`)
      .join(separator);

  lines.push(backgroundLine(renderRow(table.columns.map((column) => column.label), ctx.theme.accent2, true), ctx.size.width, ctx.theme.panel));
  const rule = widths.map((width) => "─".repeat(width)).join("─┼─");
  lines.push(backgroundLine(`${fg(ctx.theme.subtle)}${rule}${reset()}`, ctx.size.width, ctx.theme.panel));

  const visibleRows = table.rows.slice(0, MAX_TABLE_ROWS);
  for (const row of visibleRows) {
    lines.push(backgroundLine(renderRow(table.columns.map((column) => formatTableCell(row[column.key])), ctx.theme.text, false), ctx.size.width, ctx.theme.panel));
  }
  const remaining = table.rows.length - visibleRows.length;
  if (remaining > 0) {
    lines.push(backgroundLine(`${fg(ctx.theme.muted)}… +${remaining} more row${remaining === 1 ? "" : "s"} (scroll for history)${reset()}`, ctx.size.width, ctx.theme.panel));
  }
}

function renderValidation(lines: string[], block: Extract<TuiEventBlock, { type: "validation" }>, ctx: RenderContext): void {
  const statusColor = block.status === "failed" ? ctx.theme.danger : block.status === "passed" ? ctx.theme.success : ctx.theme.warning;
  const label = block.status === "running" ? "validation running" : block.status === "passed" ? "validation passed" : "validation failed";
  lines.push(backgroundLine(`${fg(statusColor)}${bold()}${label}${reset()} ${fg(ctx.theme.warning)}${block.target}${reset()}`, ctx.size.width, ctx.theme.panel));
  for (const error of block.errors ?? []) {
    for (const line of wrapText(error, textWidth(ctx, 9))) lines.push(backgroundLine(`${fg(ctx.theme.danger)}error:${reset()} ${fg(ctx.theme.text)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
  for (const warning of block.warnings ?? []) {
    for (const line of wrapText(warning, textWidth(ctx, 11))) lines.push(backgroundLine(`${fg(ctx.theme.warning)}warning:${reset()} ${fg(ctx.theme.text)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
}

function renderImage(lines: string[], block: Extract<TuiEventBlock, { type: "image" }>, ctx: RenderContext, imagePlacements: ViewportImagePlacement[]): void {
  const attachment = block.attachment;
  const protocol = detectImageProtocol();
  // A tool-produced image is labelled distinctly from one the user pasted, so the
  // transcript never implies the user attached something the agent generated.
  const label = attachment.source === "tool" ? "TOOL IMAGE" : "IMAGE";
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
  lines.push(backgroundLine(`${fg(ctx.theme.accent2)}${bold()}${label}${reset()} ${fg(ctx.theme.text)}${attachment.name}${reset()}`, ctx.size.width, ctx.theme.panel));
  lines.push(backgroundLine(`${fg(ctx.theme.subtle)}${describeAttachment(attachment)} · ${attachment.mime}${reset()}`, ctx.size.width, ctx.theme.panel));

  if (protocol === "none") {
    for (const line of wrapText(`no inline image support in this terminal · ${attachment.path}`, textWidth(ctx, 4))) {
      lines.push(backgroundLine(`${fg(ctx.theme.muted)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
    }
    lines.push(blockPaddingLine(ctx, ctx.theme.panel));
    return;
  }

  const placement = fitPlacement(attachment.width, attachment.height, Math.min(80, textWidth(ctx, 4)), Math.min(18, Math.max(4, Math.floor(ctx.size.height * 0.35))));
  const lineIndex = lines.length;
  imagePlacements.push({ id: attachment.id, lineIndex, protocol, attachment, placement });
  for (let row = 0; row < placement.rows; row++) lines.push(backgroundLine("", ctx.size.width, ctx.theme.panel));
  for (const line of wrapText(`${protocol} graphics preview · ${attachment.path}`, textWidth(ctx, 4))) {
    lines.push(backgroundLine(`${fg(ctx.theme.muted)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
  lines.push(blockPaddingLine(ctx, ctx.theme.panel));
}

function renderError(lines: string[], text: string, ctx: RenderContext): void {
  for (const line of wrapText(text, textWidth(ctx, 8))) {
    lines.push(backgroundLine(`${fg(ctx.theme.danger)}error:${reset()} ${fg(ctx.theme.text)}${line}${reset()}`, ctx.size.width, ctx.theme.panel));
  }
}

function renderLiveUi(lines: string[], block: Extract<TuiEventBlock, { type: "live_ui" }>, ctx: RenderContext, liveUiFrames?: Map<string, string[]>): void {
  // Status surfaces are rendered by StatusBar, not the scrollable viewport.
  if (block.surface === "status") return;
  const frame = liveUiFrames?.get(block.key);
  if (block.status === "error" || block.status === "exited") {
    lines.push(...renderExtensionUiErrorBlock(ctx, block.extensionId, new Error(`Live UI ${block.status === "error" ? "component crashed" : "component stopped"}: ${block.title}`)));
  } else if (frame && frame.length) {
    for (const line of frame) lines.push(padRight(line, ctx.size.width));
  } else {
    lines.push(backgroundLine(`${fg(ctx.theme.muted)}Live UI loading…${reset()} ${fg(ctx.theme.subtle)}[${block.extensionId}/${block.contributionId}]${reset()}`, ctx.size.width, ctx.theme.panel));
  }
}

function backgroundLine(content: string, width: number, fill: string): string {
  const repainted = padded(content).replaceAll(reset(), `${reset()}${bg(fill)}`);
  return `${bg(fill)}${padRight(repainted, width)}${reset()}`;
}

function blockPaddingLine(ctx: RenderContext, fill: string): string {
  return backgroundLine("", ctx.size.width, fill);
}

function padded(content: string): string {
  return `${" ".repeat(TEXT_PADDING)}${content}`;
}

function textWidth(ctx: RenderContext, reserved = 0): number {
  return Math.max(1, ctx.size.width - reserved - TEXT_PADDING);
}

function renderToolDetailSegment(detail: string, filePath: string | undefined, fallbackColor: string, ctx: RenderContext): string {
  if (!detail) return "";
  if (filePath && detail.startsWith(filePath)) {
    const range = detail.slice(filePath.length);
    return `${fg(ctx.theme.muted)}${bold()}${filePath}${reset()}${range ? `${fg(ctx.theme.muted)}${range}${reset()}` : ""}`;
  }
  return highlightDetailTokens(detail, fallbackColor, ctx);
}

function highlightDetailTokens(detail: string, fallbackColor: string, ctx: RenderContext): string {
  return detail.split(/(\s+)/).map((token, index) => {
    if (!token.trim()) return token;
    if (/^--?[\w-]+(?:=.*)?$/.test(token)) return `${fg(ctx.theme.subtle)}${token}${reset()}`;
    if (/^(['"]).*\1$/.test(token)) return `${fg(ctx.theme.success)}${token}${reset()}`;
    if (/^\d+(?:\.\d+)?$/.test(token)) return `${fg(ctx.theme.accent3)}${token}${reset()}`;
    if (isPathLikeToken(token)) return `${fg(ctx.theme.accent2)}${token}${reset()}`;
    const color = index === 0 ? fallbackColor : ctx.theme.muted;
    return `${fg(color)}${token}${reset()}`;
  }).join("");
}

function isPathLikeToken(token: string): boolean {
  return token.includes("/") || token.startsWith(".") || /\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?$/.test(token);
}

function toolDisplayLabel(block: Extract<TuiEventBlock, { type: "tool" }>): string {
  const label = block.metadata?.label;
  return typeof label === "string" && label.trim() ? label : toolAction(block.name, block.args);
}

function toolDisplayIcon(block: Extract<TuiEventBlock, { type: "tool" }>): string {
  const icon = block.metadata?.icon;
  return typeof icon === "string" && icon.trim() ? icon : toolIcon(block.name);
}

function toolAction(name: string, args?: Record<string, unknown>): string {
  if (name === "read") return "read";
  if (name === "bash") return "bash";
  if (name === "edit") return "edit";
  if (name === "write") return "write";
  if (name === "grep") return "grep";
  if (name === "list_files") return "list";
  return name;
}

function toolDetail(name: string, args?: Record<string, unknown>): string {
  if (!args) return name;
  const path = stringArg(args, "path") ?? stringArg(args, "file") ?? stringArg(args, "directory");
  if (name === "bash") return stringArg(args, "command") ?? name;
  if (name === "grep") return [stringArg(args, "pattern"), path].filter(Boolean).join(" ") || name;
  if (path) {
    const offset = numberArg(args, "offset");
    const limit = numberArg(args, "limit");
    const range = offset || limit ? `:${offset ?? 1}-${limit ? (offset ?? 1) + limit - 1 : "end"}` : "";
    return `${path}${range}`;
  }
  return formatArgs(args) || name;
}

type ToolBodyLine = { text: string; kind?: "add" | "del" | "plain" };
type DiffRow = { left?: string; right?: string; leftNumber?: number; rightNumber?: number; hunk?: string };

const TOOL_ICONS: Record<string, string> = {
  read: "▤",
  bash: "❯",
  edit: "✎",
  write: "✚",
  grep: "⌕",
  list_files: "≡"
};

function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "◆";
}

function toolFilePath(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  return stringArg(args, "path") ?? stringArg(args, "file") ?? stringArg(args, "directory");
}

function toolBody(block: Extract<TuiEventBlock, { type: "tool" }>): ToolBodyLine[] {
  const text = block.text?.trim();
  if (text) return splitLines(text).map((line) => ({ text: truncate(line, 140), kind: "plain" as const }));
  const args = formatArgs(block.args);
  return args ? splitLines(args).map((line) => ({ text: line, kind: "plain" as const })) : [];
}

// Build a git-diff style body for mutation tools so removed/added text renders red/green.
function toolDiff(block: Extract<TuiEventBlock, { type: "tool" }>): DiffRow[] | undefined {
  const args = block.args;
    if (!args) return undefined;
    if (block.name === "edit") {
      const find = stringArg(args, "find");
      const replace = typeof args.replace === "string" ? args.replace : undefined;
      if (find === undefined && replace === undefined) return undefined;
      return pairDiffLines(find, replace);
    }
    if (block.name === "write") {
      const content = stringArg(args, "content") ?? stringArg(args, "text");
      if (content === undefined) return undefined;
      return splitLines(content).map((line, index) => ({ right: truncate(line, 140), rightNumber: index + 1 }));
    }
    const metadataDiff = block.metadata?.diff;
    if (typeof metadataDiff === "string") return parseUnifiedDiff(metadataDiff);
    return undefined;
}

function pairDiffLines(before: string | undefined, after: string | undefined): DiffRow[] {
  const left = before === undefined ? [] : splitLines(before);
  const right = after === undefined ? [] : splitLines(after);
  const count = Math.max(left.length, right.length);
  return Array.from({ length: count }, (_, index) => ({
    left: left[index],
    right: right[index],
    leftNumber: left[index] === undefined ? undefined : index + 1,
    rightNumber: right[index] === undefined ? undefined : index + 1
  }));
}

function parseUnifiedDiff(value: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let leftNumber = 0;
  let rightNumber = 0;
  let pendingRemoved: Array<{ text: string; number: number }> = [];
  let pendingAdded: Array<{ text: string; number: number }> = [];
  const flush = () => {
    const count = Math.max(pendingRemoved.length, pendingAdded.length);
    for (let index = 0; index < count; index++) {
      rows.push({ left: pendingRemoved[index]?.text, leftNumber: pendingRemoved[index]?.number, right: pendingAdded[index]?.text, rightNumber: pendingAdded[index]?.number });
    }
    pendingRemoved = [];
    pendingAdded = [];
  };
  for (const line of splitLines(value)) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (header) {
      flush();
      leftNumber = Number(header[1]);
      rightNumber = Number(header[2]);
      rows.push({ hunk: `@@ -${header[1]} +${header[2]} @@${header[3] ?? ""}` });
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (line.startsWith("-")) { pendingRemoved.push({ text: line.slice(1), number: leftNumber++ }); continue; }
    if (line.startsWith("+")) { pendingAdded.push({ text: line.slice(1), number: rightNumber++ }); continue; }
    flush();
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({ left: text, right: text, leftNumber: leftNumber++, rightNumber: rightNumber++ });
  }
  flush();
  return rows;
}

function renderSideBySideDiff(lines: string[], rows: DiffRow[], ctx: RenderContext, hunkLines: number[]): void {
  const available = textWidth(ctx, 2);
  const gutterWidth = 5;
  const columnWidth = Math.max(8, Math.floor((available - 3) / 2));
  const codeWidth = Math.max(1, columnWidth - gutterWidth);
  if (!rows.some((row) => row.hunk)) hunkLines.push(lines.length);
  lines.push(backgroundLine(`${fg(ctx.theme.muted)}${padRight("BEFORE", columnWidth)} │ ${padRight("AFTER", columnWidth)}${reset()}`, ctx.size.width, ctx.theme.panel));
  lines.push(backgroundLine(`${fg(ctx.theme.subtle)}n/p jump hunks${reset()}`, ctx.size.width, ctx.theme.panel));
  for (const row of rows) {
    if (row.hunk) {
      hunkLines.push(lines.length);
      lines.push(backgroundLine(`${fg(ctx.theme.accent2)}${bold()}${truncate(row.hunk, available)}${reset()}`, ctx.size.width, ctx.theme.surfaceAlt));
      continue;
    }
    const left = row.left === undefined ? "" : `${String(row.leftNumber ?? "").padStart(3)} -${truncate(row.left, codeWidth)}`;
    const right = row.right === undefined ? "" : `${String(row.rightNumber ?? "").padStart(3)} +${truncate(row.right, codeWidth)}`;
    const leftFill = row.left === undefined ? ctx.theme.panel : ctx.theme.diffDelBg;
    const rightFill = row.right === undefined ? ctx.theme.panel : ctx.theme.diffAddBg;
    const leftCell = paintDiffCell(left, columnWidth, leftFill, ctx.theme.danger);
    const rightCell = paintDiffCell(right, columnWidth, rightFill, ctx.theme.success);
    lines.push(backgroundLine(`${leftCell}${bg(ctx.theme.panel)} ${fg(ctx.theme.muted)}│${reset()}${bg(ctx.theme.panel)} ${rightCell}`, ctx.size.width, ctx.theme.panel));
  }
}

function paintDiffCell(text: string, width: number, fill: string, color: string): string {
  return `${bg(fill)}${fg(color)}${padRight(text, width)}${reset()}`;
}

function formatArgs(args?: Record<string, unknown>): string {
  if (!args) return "";
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return "";
  if (entries.length === 1 && typeof entries[0]?.[1] === "string") return String(entries[0][1]);
  return JSON.stringify(args);
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value ? value : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

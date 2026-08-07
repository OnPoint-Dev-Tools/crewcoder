import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Component, KeyEvent, RenderContext, RenderedImagePlacement } from "../tui/component.js";
import { MainViewport } from "./MainViewport.js";
import { Composer } from "./Composer.js";
import { RightSidebar } from "./RightSidebar.js";
import { CommandPalette, builtinPaletteItems, type CommandPaletteItem } from "./CommandPalette.js";
import { SessionsOverlay } from "./SessionsOverlay.js";
import { EffortOverlay } from "./EffortOverlay.js";
import { GoalOverlay } from "./GoalOverlay.js";
import { PickerOverlay, type PickerOption } from "./PickerOverlay.js";
import { ApprovalOverlay } from "./ApprovalOverlay.js";
import { ExtensionUiOverlay } from "./ExtensionUiOverlay.js";
import { CompactionPreviewOverlay, type CompactionPreviewParams } from "./CompactionPreviewOverlay.js";
import { isTuiMode, normalizeTuiMode, pushSystemLog, TUI_MODES, type TuiDecisionExplanation, type TuiEventBlock, type TuiGoal, type TuiMode, type TuiReviewSummary, type TuiState } from "../state/tui-store.js";

const MODE_DESCRIPTIONS: Record<TuiMode, string> = {
  general: "General coding agent mode",
  plugin: "CrewCode app plugin architect mode",
  extension: "CrewCoder extension architect mode"
};
import { branchCrewCoderSession, CrewCoderProcessBridge, execCrewCoderCommand, isCrewCoderRemote, listCrewCoderExtensionRenderers, listCrewCoderLiveUiContributions, listCrewCoderProviders, listCrewCoderSessions, type CrewCoderApprovalMode, type ProviderRecord, type SessionRecord } from "../bridge/crewcoder-process.js";
import { LiveUiTrustGate } from "../bridge/live-ui-trust-gate.js";
import { LiveUiController, type LiveUiControllerCallbacks } from "../bridge/live-ui-controller.js";
import { LiveUiInstanceRegistry } from "../bridge/live-ui-registry.js";
import { LiveUiRepaintScheduler, type LiveUiFrameTheme } from "../bridge/live-ui-frame.js";
import { LiveUiSessionStore } from "../bridge/live-ui-session-store.js";
import { matchesTuiLiveUiContribution, prepareLiveUiSpawn, type LiveUiSpawnPlan, type TuiLiveUiContribution, type TuiLiveUiEvent, type TuiLiveUiGateContext } from "../bridge/live-ui-gate.js";
import type { CrewCoderLiveUiInputEvent, CrewCoderLiveUiKind } from "../bridge/live-ui-protocol.js";
import { readClipboard } from "../tui/clipboard.js";
import { applyCrewCoderEvent } from "../state/event-reducer.js";
import type { OverlayOptions } from "../tui/overlay.js";
import { bg, bold, fg, reset, stripAnsi, visibleLength } from "../tui/ansi.js";
import { DEFAULT_EFFORT, effortLevelsForModel, normalizeEffort } from "../state/effort-levels.js";
import { listPathSuggestions } from "./path-suggestions.js";
import { bigCrewCodeLogoLines, compactCrewCodeLogoLines } from "../theme/logo.js";
import { pulseClock, renderBannerPulse } from "./logo-banner.js";
import { box, emptyLine, padRight } from "../tui/layout.js";

type LoadedSkill = { name: string; description: string; body: string };
type SystemPromptSummary = { name: string; path: string; active?: boolean };
type PromptCommandArg = { name: string; description?: string; required?: boolean; default?: string };
type PromptCommandSummary = { name: string; path: string; arguments?: PromptCommandArg[] };
type LoadedPromptCommand = PromptCommandSummary & { content: string; missingArguments?: string[] };
type CompactionCliResult = { compacted: boolean; originalMessageCount?: number; retainedMessageCount?: number };
type RewindCliResult = { restoredFiles: number; deletedFiles: number };
type RewindPreviewCliResult = { restoreFiles: string[]; deleteFiles: string[]; changedFiles: string[]; missingFiles: string[]; diffs: Array<{ path: string; lines: string[]; truncated: boolean }> };
type BudgetHandoff = { sourceSessionId: string; summary: string };
export type GoalStartInput = {
  objective: string;
  maxTurns?: number;
  checkModel?: string;
  disableCheckModel?: boolean;
  timeoutMinutes?: number;
};


function parseCompactionResult(stdout: string): CompactionCliResult {
  const parsed = JSON.parse(stdout || "{}");
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  return {
    compacted: record.compacted === true,
    originalMessageCount: typeof record.originalMessageCount === "number" ? record.originalMessageCount : undefined,
    retainedMessageCount: typeof record.retainedMessageCount === "number" ? record.retainedMessageCount : undefined
  };
}

function parseRewindResult(stdout: string): RewindCliResult {
  const parsed = JSON.parse(stdout || "{}");
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  return {
    restoredFiles: typeof record.restoredFiles === "number" ? record.restoredFiles : 0,
    deletedFiles: typeof record.deletedFiles === "number" ? record.deletedFiles : 0
  };
}

function parseReviewSummary(stdout: string): TuiReviewSummary {
  const parsed = JSON.parse(stdout || "{}");
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  return {
    branch: typeof record.branch === "string" && record.branch.trim() ? record.branch : undefined,
    clean: record.clean === true,
    changedFiles: stringList(record.changedFiles),
    issueReferences: issueReferenceList(record.issueReferences)
  };
}

/**
 * Parse `session why --json`. Returns undefined when the backend reported that
 * there is no decision to explain, so the caller can say so instead of rendering
 * an empty card.
 */
function parseDecisionExplanation(stdout: string): TuiDecisionExplanation | undefined {
  const parsed: unknown = JSON.parse(stdout || "{}");
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  if (record.explained !== true) return undefined;
  const explanation = typeof record.explanation === "string" ? record.explanation.trim() : "";
  if (!explanation) return undefined;
  const decision = record.decision && typeof record.decision === "object" ? record.decision as Record<string, unknown> : {};
  const toolCalls = Array.isArray(decision.toolCalls) ? decision.toolCalls : [];
  return {
    explanation,
    source: record.source === "model" ? "model" : "transcript",
    fallbackReason: typeof record.fallbackReason === "string" && record.fallbackReason.trim() ? record.fallbackReason : undefined,
    toolCalls: toolCalls.flatMap((call) => {
      if (!call || typeof call !== "object") return [];
      const name = (call as Record<string, unknown>).name;
      return typeof name === "string" ? [name] : [];
    }),
    changedFiles: stringList(decision.changedFiles)
  };
}

function parseGoalRecord(stdout: string): TuiGoal | undefined {
  const parsed: unknown = JSON.parse(stdout || "null");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const status = goalStatus(record.status);
  if (typeof record.id !== "string" || typeof record.objective !== "string" || !status) return undefined;
  const pending = record.pendingApproval && typeof record.pendingApproval === "object" && !Array.isArray(record.pendingApproval)
    ? record.pendingApproval as Record<string, unknown>
    : undefined;
  return {
    id: record.id,
    objective: record.objective,
    status,
    provider: typeof record.provider === "string" ? record.provider : "unknown",
    model: typeof record.model === "string" ? record.model : "unknown",
    cycle: typeof record.cycle === "number" ? record.cycle : 0,
    maxTurns: typeof record.maxTurns === "number" ? record.maxTurns : undefined,
    checkModel: typeof record.checkModel === "string" ? record.checkModel : undefined,
    timeoutMinutes: typeof record.timeoutMinutes === "number" ? record.timeoutMinutes : undefined,
    lastCheck: parseGoalCheck(record.lastCheck),
    sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    pauseReason: typeof record.pauseReason === "string" ? record.pauseReason : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
    completionSummary: typeof record.completionSummary === "string" ? record.completionSummary : undefined,
    completionEvidence: typeof record.completionEvidence === "string" ? record.completionEvidence : undefined,
    pendingApproval: pending && typeof pending.toolName === "string" && typeof pending.reason === "string" ? { toolName: pending.toolName, reason: pending.reason } : undefined
  };
}

function parseGoalCheck(value: unknown): TuiGoal["lastCheck"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if ((record.verdict !== "continue" && record.verdict !== "complete") || typeof record.reason !== "string" || typeof record.model !== "string") return undefined;
  return { verdict: record.verdict, reason: record.reason, model: record.model, evidence: typeof record.evidence === "string" ? record.evidence : undefined };
}

function goalStatus(value: unknown): TuiGoal["status"] | undefined {
  if (value === "queued" || value === "running" || value === "awaiting_approval" || value === "paused" || value === "completed" || value === "failed" || value === "cancelled") return value;
  return undefined;
}

function issueReferenceList(value: unknown): TuiReviewSummary["issueReferences"] {
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

function parseRewindPreviewResult(stdout: string): RewindPreviewCliResult {
  const parsed = JSON.parse(stdout || "{}");
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  return {
    restoreFiles: stringList(record.restoreFiles),
    deleteFiles: stringList(record.deleteFiles),
    changedFiles: stringList(record.changedFiles),
    missingFiles: stringList(record.missingFiles),
    diffs: diffList(record.diffs)
  };
}

function diffList(value: unknown): Array<{ path: string; lines: string[]; truncated: boolean }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string") return [];
    return [{ path: record.path, lines: stringList(record.lines), truncated: record.truncated === true }];
  });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export class App implements Component {
  private readonly viewport: MainViewport;
  private readonly composer: Composer;
  private readonly rightSidebar: RightSidebar;
  private readonly commands = new CommandPalette(
    (item) => this.selectPaletteItem(item),
    (query) => { this.state.input = query; this.state.inputCursor = query.length; }
  );
  private readonly bridge = new CrewCoderProcessBridge();
  private activePopover: { component: Component; height: number; kind: "commands" | "panel" | "mentions" | "agents" | "approval" | "extension_ui" | "compaction_preview"; approvalId?: string; requestId?: string; previewId?: string } | undefined;
  private mentionRequestId = 0;
  private commandPaletteRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private modalContentOrigin: { x: number; y: number } | undefined;
  private pendingSkills: LoadedSkill[] = [];
  private cachedWorkers: Array<{ name: string; active: boolean; ownerName: string | null }> = [];
  private forceConversationView = false;
  /**
   * True only while an agent run is actually in flight (one user message through
   * to its final answer, however many loop iterations that takes). Tracked from
   * agent-loop lifecycle events rather than child-process liveness: a finished
   * run keeps its process alive briefly while the session saves, and longer with
   * providers that hold handles open. Messages sent in that window start a new
   * run against the same durable session; they are not follow-ups.
   */
  private runActive = false;
  private pendingCompactionPreview: { mode: "live"; previewId: string } | { mode: "idle"; sessionId: string } | undefined;
  private pendingBudgetHandoff: BudgetHandoff | undefined;
  private viewportTop = 1;
  private composerTop = 1;
  private inlinePopoverTop = 0;
  private noticePopupUntil = 0;
  private noticePopupText = "";
  private noticePopupColor: "success" | "warning" = "success";
  private homeActive = false;
  private homeComposerLeft = 0;
  private homeIdleSince: number | undefined;
  private sidebarOpen = false;
  private sidebarPreferredWidth: number | undefined;
  private sidebarResizing = false;
  private layoutContentWidth = 0;
  private layoutTotalWidth = 0;
  private readonly liveUiTrustGate = new LiveUiTrustGate();
  private readonly liveUiRegistry = new LiveUiInstanceRegistry();
  private readonly liveUiScheduler = new LiveUiRepaintScheduler(() => this.repaint?.());
  private readonly sessionStore = new LiveUiSessionStore(path.join(crewcoderHomeRoot(), "cache", "live-ui-sessions"));
  readonly liveUiController: LiveUiController;
  pushOverlay?: (component: Component, options?: OverlayOptions) => void;
  closeOverlay?: () => void;
  repaint?: () => void;

  constructor(private readonly state: TuiState) {
    this.viewport = new MainViewport(state);
    this.rightSidebar = new RightSidebar(state);
    this.composer = new Composer(state, (value) => this.submit(value));
    this.liveUiController = new LiveUiController({
      trustGate: this.liveUiTrustGate,
      registry: this.liveUiRegistry,
      scheduler: this.liveUiScheduler,
      callbacks: {
        onFocusChange: (focus) => { this.state.liveUiFocus = focus; },
        onUnhandledInput: (event) => { this.handleLiveUiUnhandledInput(event); },
        readSessionState: (extensionId, key) => this.sessionStore.read(this.state.sessionId, extensionId, key),
        writeSessionState: (extensionId, key, value) => {
          if (this.state.sessionId && this.state.sessionId !== "new") {
            this.sessionStore.write(this.state.sessionId, extensionId, key, value);
          }
        },
        readClipboard: () => readClipboard(),
        networkFetch: async (url, options, allowedHosts) => {
          const hostname = extractHostname(url);
          if (!hostname || !allowedHosts.includes(hostname)) {
            return { error: `URL hostname "${hostname ?? "unknown"}" is not in the allowed hosts list` };
          }
          try {
            const response = await fetch(url, {
              method: options.method ?? "GET",
              headers: options.headers,
              body: options.body
            });
            const body = await response.text();
            return { status: response.status, body };
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        }
      }
    });
  }

  async initialize(): Promise<void> {
    const [config, profile] = await Promise.all([readCrewCoderConfig(), readEffectiveIntegrationProfile()]);
    this.applyReloadedConfig(config ? { ...config, integrationProfile: profile } : { integrationProfile: profile });
    const detection = await readCrewCodeProjectDetection();
    if (this.state.integrationProfile === "standalone" && detection.shouldPrompt) this.openCrewCodeDetectionPrompt(detection.markers);
    this.repaint?.();
  }

  render(ctx: RenderContext): string[] {
    this.layoutTotalWidth = ctx.size.width;
    const sidebarWidth = this.sidebarOpen ? rightSidebarWidth(ctx.size.width, this.sidebarPreferredWidth) : 0;
    const contentWidth = ctx.size.width - sidebarWidth - (sidebarWidth > 0 ? 1 : 0);
    this.layoutContentWidth = contentWidth;
    const contentCtx = { ...ctx, size: { width: contentWidth, height: ctx.size.height } };
    const wasHome = this.homeActive;
    this.homeActive = this.isHomeScreen();
    if (this.homeActive) {
      if (!wasHome || this.homeIdleSince === undefined) this.homeIdleSince = Date.now();
    } else {
      this.homeIdleSince = undefined;
    }
    this.refreshLiveUiFrames(contentCtx);
    const body = this.homeActive ? this.renderHome(contentCtx) : this.renderNormal(contentCtx);
    const base = body.slice(0, contentCtx.size.height);
    const composed = this.isModalPopover() ? this.compositeModal(base, contentCtx) : base;
    const content = this.renderNoticePopup(composed, contentCtx);
    if (sidebarWidth <= 0) return content;
    const sidebarLines = this.rightSidebar.render({ ...ctx, size: { width: sidebarWidth, height: ctx.size.height } });
    return renderRightSidebar(content, sidebarLines, contentWidth, ctx);
  }

  private renderNormal(ctx: RenderContext): string[] {
    const mainWidth = ctx.size.width;
    const viewportComposerGap = 1;
    const maxComposerHeight = Math.max(5, Math.floor(ctx.size.height * 0.35));
    const composerHeight = Math.min(this.composer.height(mainWidth), maxComposerHeight);
    // In conversation view, slash commands and @ mentions are inline composer autocomplete.
    const inlinePopover = this.activePopover?.kind === "mentions" || this.activePopover?.kind === "commands" ? this.activePopover : undefined;
    const inlineHeight = inlinePopover ? Math.min(inlinePopover.height, Math.max(0, ctx.size.height - composerHeight - viewportComposerGap)) : 0;
    const viewportHeight = Math.max(1, ctx.size.height - composerHeight - inlineHeight - viewportComposerGap);
    this.viewportTop = 1;
    this.composerTop = viewportHeight + viewportComposerGap + 1;
    // With no persistent header, viewport-relative rows are terminal rows.
    const viewportLines = this.viewport.render({ ...ctx, size: { width: mainWidth, height: viewportHeight } });
    const composerLines = this.composer.render({ ...ctx, size: { width: mainWidth, height: composerHeight } });
    const gapLines = Array.from({ length: viewportComposerGap }, () => emptyLine(mainWidth));
    this.inlinePopoverTop = this.composerTop + composerLines.length;
    const inlineLines = inlinePopover ? this.renderPopover({ ...ctx, size: { width: mainWidth, height: inlineHeight } }, inlineHeight) : [];
    return [...viewportLines, ...gapLines, ...composerLines, ...inlineLines];
  }

  private isModalPopover(): boolean {
    if (!this.activePopover || this.activePopover.kind === "mentions") return false;
    if (this.activePopover.kind === "commands") return this.homeActive;
    return true;
  }

  private refreshLiveUiFrames(ctx: RenderContext): void {
    if (!this.state.liveUiFrames) this.state.liveUiFrames = new Map();
    const theme: LiveUiFrameTheme = { border: ctx.theme.border, focusBorder: ctx.theme.primary, title: ctx.theme.accent, text: ctx.theme.text };
    for (const block of this.state.blocks) {
      if (block.type !== "live_ui") continue;
      const size = liveUiSurfaceSize(block.surface, ctx.size);
      this.liveUiController.resize(block.key, size.width, size.height);
      const boxed = block.surface !== "status";
      const frame = this.liveUiController.frame(block.key, theme, { width: size.width, height: size.height }, { boxed });
      if (frame) this.state.liveUiFrames.set(block.key, frame);
    }
  }

  // Draws the active command/picker popover as a centered modal box on top of the
  // base layout, mirroring OverlayManager's compositing. ESC-to-close is handled in
  // handleInput via closeActivePopover.
  private compositeModal(base: string[], ctx: RenderContext): string[] {
    const popover = this.activePopover;
    if (!popover) return base;
    const component = popover.component as Component & { desiredHeight?: (width: number) => number };
    const boxWidth = Math.min(Math.max(48, Math.floor(ctx.size.width * 0.66)), ctx.size.width - 4);
    const innerWidth = boxWidth - 2;
    // Breathing room between the border and the content.
    const padX = 2;
    const padY = 1;
    const contentWidth = Math.max(1, innerWidth - padX * 2);
    const desired = component.desiredHeight?.(contentWidth) ?? popover.height;
    const innerHeight = Math.max(6 + padY * 2, Math.min(desired + padY * 2, ctx.size.height - 4));
    const contentHeight = Math.max(1, innerHeight - padY * 2);
    const body = component.render({ ...ctx, size: { width: contentWidth, height: contentHeight } });
    const content = body.slice(0, contentHeight);
    while (content.length < contentHeight) content.push(emptyLine(contentWidth));
    const gutter = emptyLine(innerWidth);
    const inner = [
      ...Array.from({ length: padY }, () => gutter),
      ...content.map((line) => padRight(" ".repeat(padX) + line, innerWidth)),
      ...Array.from({ length: padY }, () => gutter)
    ];
    // Modal chrome must use its own opaque fill. Reusing the transcript panel
    // color makes underlying tool blocks look as if they continue through gaps
    // in the modal, especially on terminals with large colored regions.
    const modalFill = ctx.theme.backgroundAlt;
    // Paint only the interior before adding the frame. Painting the completed box
    // leaves the modal background active behind the right border glyph, which
    // makes that edge appear as a thick or discolored vertical strip.
    const panel = box(inner.map((line) => paintBackground(line, modalFill)), boxWidth, ctx.theme.borderStrong);

    const top = Math.max(0, Math.floor((ctx.size.height - panel.length) / 2));
    const left = Math.max(0, Math.floor((ctx.size.width - boxWidth) / 2));
    // Terminal mouse coordinates are 1-based. Account for modal border/padding.
    this.modalContentOrigin = { x: left + 2 + padX, y: top + 2 + padY };
    // Graphics are drawn above the text cells and cannot be clipped, so an image
    // behind the modal would bleed through the box.
    suppressImagesUnder(ctx.imagePlacements, { top: top + 1, left: left + 1, width: boxWidth, height: panel.length });
    const result = [...base];
    for (let i = 0; i < panel.length; i++) {
      const row = top + i;
      if (row >= result.length) break;
      const current = stripToWidth(result[row] ?? "", ctx.size.width);
      result[row] = padRight(current.slice(0, left) + panel[i] + current.slice(left + boxWidth), ctx.size.width);
    }
    return result;
  }

  handleInput(event: KeyEvent): void | boolean {
    // Any activity on the home screen restarts the pulse-freeze idle timer.
    if (this.homeActive) this.homeIdleSince = Date.now();

    if (this.handleGlobalShortcut(event)) return true;
    if (this.handleSidebarResizeInput(event)) return true;

    if (event.name === "wheelup" || event.name === "wheeldown") {
      const delta = event.name === "wheelup" ? -3 : 3;
      if (this.liveUiController.scrollFocused(delta)) return true;
    }

    const liveUiInput = this.toLiveUiInput(event);
    if (liveUiInput && this.liveUiController.sendInput(liveUiInput)) return true;

    if (this.activePopover) {
      if (event.name === "mouse" || event.name === "wheelup" || event.name === "wheeldown") return this.handlePopoverMouse(event);
      if (event.name === "escape") {
        if (this.activePopover.kind === "extension_ui" && this.activePopover.requestId) {
          this.resolveUiRequestCommand(this.activePopover.requestId, null);
        } else if (this.activePopover.kind === "compaction_preview") {
          this.cancelCompactionPreview();
        } else {
          this.closeActivePopover();
        }
        return true;
      }
      if (this.activePopover.kind === "commands") {
        return this.activePopover.component.handleInput?.(event) ?? true;
      } else if (this.activePopover.kind === "mentions") {
        if (event.name === "up" || event.name === "down" || event.name === "return") {
          return this.activePopover.component.handleInput?.(event);
        }
      } else {
        return this.activePopover.component.handleInput?.(event);
      }
    }

    if (event.name === "escape" && this.state.running) {
      this.abortActiveRequest();
      return true;
    }

    if (event.name === "mouse") return this.handleMouseInput(event);

    // Up/Down first navigate within a multi-line composer; only when the cursor is
    // already at the first/last input line do they fall through to viewport scroll.
    if ((event.name === "up" || event.name === "down") && this.composer.handleVerticalArrow(event.name)) {
      this.syncInputPopovers();
      return true;
    }

    const viewportHandled = this.handleViewportInput(event);
    if (viewportHandled) return true;

    const handled = this.composer.handleInput(event);
    this.syncInputPopovers();
    return handled;
  }

  stop(): void { this.bridge.stop(); }

  private handlePopoverMouse(event: KeyEvent): boolean {
    if (!this.activePopover) return false;
        if (this.activePopover.kind === "mentions" || (this.activePopover.kind === "commands" && !this.homeActive)) {
          if (!event.mouse) return this.activePopover.component.handleInput?.(event) ?? true;
          const local: KeyEvent = { ...event, mouse: { ...event.mouse, y: event.mouse.y - this.inlinePopoverTop + 1 } };
          return this.activePopover.component.handleInput?.(local) ?? true;
        }
        const origin = this.modalContentOrigin;
        if (!origin) return true;
        const sourceMouse = event.mouse;
        if (!sourceMouse) return this.activePopover.component.handleInput?.(event) ?? true;
        const local: KeyEvent = {
          ...event,
          mouse: { ...sourceMouse, x: sourceMouse.x - origin.x + 1, y: sourceMouse.y - origin.y + 1 }
        };
        if (local.mouse!.x < 1 || local.mouse!.y < 1) return true;
        return this.activePopover.component.handleInput?.(local) ?? true;
  }

  private handleSidebarResizeInput(event: KeyEvent): boolean {
    if (event.name !== "mouse" || !event.mouse) return false;
    const dividerX = this.layoutContentWidth + 1;
    if (!this.sidebarResizing) {
      if (!this.sidebarOpen || this.layoutTotalWidth < MIN_SIDEBAR_TERMINAL_WIDTH || event.mouse.kind !== "press" || event.mouse.x !== dividerX) return false;
      this.sidebarResizing = true;
      return true;
    }
    if (event.mouse.kind === "release") {
      this.sidebarResizing = false;
      return true;
    }
    if (event.mouse.kind === "drag") {
      this.sidebarPreferredWidth = clampSidebarWidth(this.layoutTotalWidth - event.mouse.x, this.layoutTotalWidth);
      return true;
    }
    return true;
  }

  private handleMouseInput(event: KeyEvent): boolean {
    if ((event.mouse?.x ?? 0) > this.layoutContentWidth) return true;
    const y = event.mouse?.y ?? 0;
    const notify = () => this.showCopiedPopup();
    if (this.homeActive) {
      if (y < this.composerTop || !event.mouse) return false;
      const shifted: KeyEvent = { ...event, mouse: { ...event.mouse, x: event.mouse.x - this.homeComposerLeft } };
      return this.composer.handleMouse(shifted, this.composerTop, undefined, notify);
    }
    if (y >= this.composerTop) return this.composer.handleMouse(event, this.composerTop, undefined, notify);
    if (y >= this.viewportTop && y < this.composerTop - 1) return this.viewport.handleMouse(event, this.viewportTop, undefined, notify);
    return false;
  }

  /**
   * Convert a TUI KeyEvent into the live UI wire format. Mouse events are
   * translated from terminal coordinates into frame-relative coordinates before
   * forwarding so the child can interpret clicks within its own bounds.
   */
  private toLiveUiInput(event: KeyEvent): CrewCoderLiveUiInputEvent | undefined {
    if (event.name === "mouse") {
      const mouse = this.convertMouseToLiveUiCoords(event);
      if (!mouse) return undefined;
      return {
        name: event.name,
        ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
        mouse
      };
    }
    return keyEventToLiveUiInput(event);
  }

  private convertMouseToLiveUiCoords(event: KeyEvent): { x: number; y: number; button: number; kind: "press" | "drag" | "release" | "wheel" | "hover" } | undefined {
    if (!event.mouse || !this.state.liveUiFocus) return undefined;
    const focus = this.state.liveUiFocus;
    const terminalX = event.mouse.x;
    const terminalY = event.mouse.y;
    if (focus.surface === "status") {
      return { x: terminalX - 1, y: terminalY - 1, button: event.mouse.button, kind: event.mouse.kind };
    }
    // For viewport-anchored surfaces (modal/transcript) the best origin we can
    // compute without per-block position tracking is the viewport top-left.
    return { x: terminalX - 1, y: terminalY - this.viewportTop, button: event.mouse.button, kind: event.mouse.kind };
  }

  private isHomeScreen(): boolean {
    if (this.forceConversationView) return false;
    return !this.state.running && !this.state.blocks.some((block) => block.type === "user" || block.type === "assistant");
  }

  private renderHome(ctx: RenderContext): string[] {
    const width = ctx.size.width;
    const height = ctx.size.height;

    const logoArt = width >= 70 ? bigCrewCodeLogoLines : compactCrewCodeLogoLines;
    const logo = renderBannerPulse(logoArt, width, ctx.theme, pulseClock(this.homeIdleSince ?? Date.now(), Date.now()));

    const composerWidth = Math.max(24, Math.min(width, Math.floor(width * 0.62)));
    this.homeComposerLeft = Math.max(0, Math.floor((width - composerWidth) / 2));
    const composerBody = this.composer.render({ ...ctx, size: { width: composerWidth, height: this.composer.height(composerWidth) } });
    const composerLines = composerBody.map((line) => indentLine(line, this.homeComposerLeft, width));

    const hintText = `${fg(ctx.theme.muted)}tab ${fg(ctx.theme.subtle)}agents${reset()}   ${fg(ctx.theme.muted)}ctrl+p ${fg(ctx.theme.subtle)}commands${reset()}`;
    const hint = alignRight(hintText, this.homeComposerLeft + composerWidth, width);

    const mention = this.activePopover?.kind === "mentions" ? this.activePopover : undefined;
    const popoverLines = mention
      ? mention.component
          .render({ ...ctx, size: { width: composerWidth, height: mention.height } })
          .slice(0, mention.height)
          .map((line) => indentLine(line, this.homeComposerLeft, width))
      : [];

    const tip = centerLine(
      `${fg(ctx.theme.accent2)}Tip${reset()} ${fg(ctx.theme.subtle)}Press ${reset()}${fg(ctx.theme.muted)}/${reset()}${fg(ctx.theme.subtle)}model,${reset()}${fg(ctx.theme.subtle)} Then type your first request below${reset()}`,
      width
    );

    const content = [
      ...logo,
      emptyLine(width),
      ...composerLines,
      hint,
      ...(popoverLines.length ? [emptyLine(width), ...popoverLines] : []),
      emptyLine(width),
      tip
    ];

    const topPad = Math.max(0, Math.floor((height - content.length) / 2));
    this.composerTop = topPad + logo.length + 1 + 1; // top padding + logo + blank gap, 1-indexed rows
    const lines = [
      ...Array.from({ length: topPad }, () => emptyLine(width)),
      ...content
    ];
    while (lines.length < height) lines.push(emptyLine(width));
    return lines.slice(0, height);
  }

  private handleViewportInput(event: KeyEvent): boolean {
    const page = Math.max(3, this.state.viewportHeight - 2);
    if (!this.state.input && !event.ctrl && !event.meta && event.name === "n" && this.viewport.jumpDiffHunk("next")) return true;
    if (!this.state.input && !event.ctrl && !event.meta && event.name === "p" && this.viewport.jumpDiffHunk("previous")) return true;
    if (event.ctrl && event.name === "o") {
      this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
      this.state.viewportScroll = 0;
      pushSystemLog(this.state, `Tool output ${this.state.toolOutputExpanded ? "expanded" : "collapsed"}.`);
      return true;
    }
    if (event.name === "up" || event.name === "wheelup") { this.state.viewportScroll += 3; return true; }
    if (event.name === "down" || event.name === "wheeldown") { this.state.viewportScroll = Math.max(0, this.state.viewportScroll - 3); return true; }
    if (event.name === "pageup") { this.state.viewportScroll += page; return true; }
    if (event.name === "pagedown") { this.state.viewportScroll = Math.max(0, this.state.viewportScroll - page); return true; }
    if (event.name === "home" && event.ctrl) { this.state.viewportScroll = Number.MAX_SAFE_INTEGER; return true; }
    if (event.name === "end" || (event.name === "home" && !event.ctrl)) { this.state.viewportScroll = 0; return true; }
    return false;
  }

  private submit(value: string): void {
    if (value === "/quit") process.exit(0);
    if (value === "/help" || value === "/") { this.openCommandPopover(value); return; }
    if (value === "/commands") { void this.openPromptCommandsOverlay(); return; }
    if (value.startsWith("/commands ") || value.startsWith("commands ")) {
      const parsed = this.parsePromptCommandInput(value.replace(/^\/?commands\s+/, "").trim());
      void this.insertPromptCommandByName(parsed.name, parsed.args);
      return;
    }
    if (value === "/sessions" || value === "/resume") { this.openSessionsOverlay(); return; }
    if (value === "/new") { this.startNewSession(); return; }
    if (value === "/reload") { void this.reloadCliMetadata(); return; }
    if (value === "/repaint" || value === "/redraw") { this.forceRepaint(); return; }
    if (value === "/sidebar" || value === "sidebar") { this.toggleSidebar(); return; }
    if (value.startsWith("/sidebar ") || value.startsWith("sidebar ")) { this.setSidebar(value.replace(/^\/?sidebar\s+/, "").trim()); return; }
    if (value === "/effort") { this.openEffortOverlay(); return; }
    if (value.startsWith("/effort ") || value.startsWith("effort ")) { this.setEffort(value.replace(/^\/?effort\s+/, "").trim()); return; }
    if (value === "/thinking" || value === "thinking") { void this.setThinking("status"); return; }
    if (value.startsWith("/thinking ") || value.startsWith("thinking ")) { void this.setThinking(value.replace(/^\/?thinking\s+/, "").trim()); return; }
    if (value === "/full-access" || value === "full-access") { this.toggleFullAccess(); return; }
    if (value.startsWith("/full-access ") || value.startsWith("full-access ")) { this.setFullAccess(value.replace(/^\/?full-access\s+/, "").trim()); return; }
    if (value === "/checkpoints" || value === "checkpoints") { void this.setCheckpoints("status"); return; }
    if (value.startsWith("/checkpoints ") || value.startsWith("checkpoints ")) { void this.setCheckpoints(value.replace(/^\/?checkpoints\s+/, "").trim()); return; }
    if (value === "/file-changes" || value === "file-changes") { this.setFileChangesDisplay(this.state.showFileChanges ? "off" : "on"); return; }
    if (value.startsWith("/file-changes ") || value.startsWith("file-changes ")) { this.setFileChangesDisplay(value.replace(/^\/?file-changes\s+/, "").trim()); return; }
    if (value === "/memory" || value === "memory") { void this.runCliCommand(["memory", "status"]); return; }
    if (value.startsWith("/memory ") || value.startsWith("memory ")) {
      const action = value.replace(/^\/?memory\s+/, "").trim().toLowerCase();
      if (action === "on" || action === "off" || action === "status" || action === "list") { void this.runCliCommand(["memory", action]); return; }
      this.state.blocks.push({ type: "error", text: "Usage: /memory on|off|status|list" });
      return;
    }
    if (value === "/remember" || value === "remember") { this.state.blocks.push({ type: "error", text: "Usage: /remember <fact> (enable first with /memory on)" }); return; }
    if (value.startsWith("/remember ") || value.startsWith("remember ")) {
      const fact = value.replace(/^\/?remember\s+/, "").trim();
      if (!fact) { this.state.blocks.push({ type: "error", text: "Usage: /remember <fact> (enable first with /memory on)" }); return; }
      void this.runCliCommand(["remember", fact]);
      return;
    }
    if (value === "/set-budget" || value === "set-budget") { this.setTokenBudget(""); return; }
    if (value.startsWith("/set-budget ") || value.startsWith("set-budget ")) { this.setTokenBudget(value.replace(/^\/?set-budget\s+/, "").trim()); return; }
    if (value === "/add-dir" || value === "add-dir") { this.showExternalDirectories("add"); return; }
    if (value.startsWith("/add-dir ") || value.startsWith("add-dir ")) { void this.addExternalDirectory(value.replace(/^\/?add-dir\s+/, "").trim()); return; }
    if (value === "/remove-dir" || value === "remove-dir") { this.showExternalDirectories("remove"); return; }
    if (value.startsWith("/remove-dir ") || value.startsWith("remove-dir ")) { void this.removeExternalDirectory(value.replace(/^\/?remove-dir\s+/, "").trim()); return; }
    if (value === "/goal" || value === "goal") { void this.openGoalOverlay(); return; }
    if (value.startsWith("/goal ") || value.startsWith("goal ")) { void this.runGoalCommand(value.replace(/^\/?goal\s*/, "").trim()); return; }
    if (value === "/handoff" || value === "handoff") { void this.openHandoffWorkerPicker(); return; }
    if (value.startsWith("/handoff ") || value.startsWith("handoff ")) { void this.runWorkerHandoff(value.replace(/^\/?handoff\s+/, "").trim()); return; }
    if (value === "/crew" || value === "crew") { this.state.blocks.push({ type: "error", text: "Usage: /crew <worker1,worker2> <task>" }); return; }
    if (value.startsWith("/crew ") || value.startsWith("crew ")) { void this.runWorkerCrewCommand(value.replace(/^\/?crew\s+/, "").trim()); return; }
    if (value === "/teams" || value === "teams") { void this.runCliCommand(["crew", "team", "list"]); return; }
    if (value === "/team" || value === "team") { this.state.blocks.push({ type: "error", text: "Usage: /team <team> <task> (use /teams to list teams)" }); return; }
    if (value.startsWith("/team ") || value.startsWith("team ")) { void this.runWorkerTeamCommand(value.replace(/^\/?team\s+/, "").trim()); return; }
    if (value === "/provider" || value === "provider") { void this.openProviderOverlay(); return; }
    if (value === "/mode" || value === "mode" || value === "/modes" || value === "modes" || value === "/workers" || value === "workers" || value === "/worker" || value === "worker") { void this.openModesOverlay(); return; }
    if (value === "/model" || value === "model") { void this.openModelOverlay(); return; }
    if (value === "/extensions") { void this.runCliCommand(["extension", "list"]); return; }
    if (value === "/skills") { void this.openSkillsOverlay(); return; }
    if (value.startsWith("/skills ") || value.startsWith("skills ")) {
      const name = value.replace(/^\/?skills\s+/, "").trim();
      void this.attachSkillByName(name);
      return;
    }
    if (value === "/prompts") { void this.openSystemPromptsOverlay(); return; }
    if (value.startsWith("/prompts ") || value.startsWith("prompts ")) {
      const name = value.replace(/^\/?prompts\s+/, "").trim();
      void this.selectSystemPromptByName(name);
      return;
    }
    if (value === "/profile" || value === "profile") { this.openIntegrationProfilePicker(); return; }
    if (value.startsWith("/profile ") || value.startsWith("profile ")) { void this.setIntegrationProfile(value.replace(/^\/?profile\s+/, "").trim()); return; }
    if (value === "/plugins") {
      if (this.state.integrationProfile !== "crewcode") { this.crewCodeDisabledNotice(); return; }
      void this.runCliCommand(["plugin", "list-templates"]); return;
    }
    if (value === "/task" || value === "task") { this.setTaskInstanceOverride("status"); return; }
    if (value.startsWith("/task ") || value.startsWith("task ")) {
      const parts = value.replace(/^\/?task\s+/, "").trim().split(/\s+/).filter(Boolean);
      const action = parts[0]?.toLowerCase();
      if (action === "on" || action === "off" || action === "status") { this.setTaskInstanceOverride(action); return; }
      void this.runCliCommand(["task", ...parts]);
      return;
    }
    if (value === "/follow-up" || value === "follow-up" || value === "/followup" || value === "followup") {
      this.state.blocks.push({ type: "error", text: "Usage: /follow-up <message>" });
      return;
    }
    if (value.startsWith("/follow-up ") || value.startsWith("follow-up ") || value.startsWith("/followup ") || value.startsWith("followup ")) {
      this.queueFollowUp(value.replace(/^\/?follow-?up\s+/, "").trim());
      return;
    }
    if (value === "/approve" || value === "approve" || value.startsWith("/approve ") || value.startsWith("approve ")) {
      this.resolveApprovalCommand(value.replace(/^\/?approve\s*/, "").trim(), true);
      return;
    }
    if (value === "/deny" || value === "deny" || value.startsWith("/deny ") || value.startsWith("deny ")) {
      this.resolveApprovalCommand(value.replace(/^\/?deny\s*/, "").trim(), false);
      return;
    }
    if (value === "/compact") { void this.compactCurrentSession(); return; }
    if (value.startsWith("/compact ") || value.startsWith("compact ")) {
      const arg = value.replace(/^\/?compact\s+/, "").trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        pushSystemLog(this.state, `Auto-compaction ${arg === "on" ? "enabled" : "disabled"}.`);
        void this.runCliCommand(["config", "set", "autoCompact", arg === "on" ? "true" : "false"]);
        return;
      }
      if (arg === "status") { void this.runCliCommand(["config", "show"]); return; }
      if (arg === "preview" || arg === "edit") { this.startCompactionPreview(); return; }
      pushSystemLog(this.state, "Usage: /compact (compact now), /compact preview|edit, /compact on|off, /compact status");
      return;
    }
    if (value === "/export" || value === "export") { void this.exportCurrentSession(); return; }
    if (value.startsWith("/export ") || value.startsWith("export ")) {
      void this.exportCurrentSession(value.replace(/^\/?export\s+/, "").trim());
      return;
    }
    if (value === "/clear") { this.state.blocks = []; this.forceConversationView = false; return; }
    if (value === "/stop") { this.abortActiveRequest(); return; }
    if (value === "/branch") { void this.branchCurrentSession(); return; }
    if (value === "/review-summary" || value === "review-summary") { void this.showReviewSummary(); return; }
    if (value === "/why" || value === "why") { void this.explainLastDecision(); return; }
    if (value === "/rewind" || value === "rewind") { this.openRewindPicker(); return; }
    if (value.startsWith("/rewind ") || value.startsWith("rewind ")) { void this.rewindCurrentSession(value.replace(/^\/?rewind\s+/, "").trim()); return; }
    if (value.startsWith("/provider ") || value.startsWith("provider ")) {
      this.state.provider = value.replace(/^\/?provider\s+/, "").trim() || this.state.provider;
      const levels = effortLevelsForModel(this.state.provider, this.state.model);
      if (!levels.includes(this.state.effort)) this.state.effort = levels[0] ?? this.state.effort;
      pushSystemLog(this.state, `Provider set to ${this.state.provider}`);
      return;
    }
    if (/^\/?(modes?|workers?)\s+/.test(value)) {
      const name = value.replace(/^\/?(modes?|workers?)\s+/, "").trim();
      void this.selectModeOrWorker(name);
      return;
    }
    if (value.startsWith("/model ") || value.startsWith("model ")) {
      this.state.model = value.replace(/^\/?model\s+/, "").trim() || this.state.model;
      const levels = effortLevelsForModel(this.state.provider, this.state.model);
      if (!levels.includes(this.state.effort)) this.state.effort = levels[0] ?? this.state.effort;
      pushSystemLog(this.state, `Model set to ${this.state.model}`);
      return;
    }
    if (value.startsWith("/ext.")) {
      const parsed = this.parseDirectExtensionCommand(value);
      void this.runCliCommand(["command", "run", parsed.name, ...parsed.args]);
      return;
    }
    if (value.startsWith("/")) { pushSystemLog(this.state, `Unknown command: ${value}`); return; }
    if (this.bridge.running && this.runActive) { this.queueFollowUp(value); return; }
    this.runPrompt(value);
  }

  private forceRepaint(): void {
    this.repaint?.();
    this.showNoticePopup("✓ Repainted TUI", "success");
  }

  private toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
    if (!this.sidebarOpen) this.sidebarResizing = false;
    this.showNoticePopup(`Sidebar ${this.sidebarOpen ? "opened" : "closed"}`, "success");
    this.repaint?.();
  }

  private setSidebar(value: string): void {
    const normalized = value.trim().toLowerCase();
    if (normalized === "status") {
      this.showNoticePopup(`Sidebar is ${this.sidebarOpen ? "open" : "closed"}`, "success");
      return;
    }
    if (normalized !== "on" && normalized !== "off") {
      this.state.blocks.push({ type: "error", text: "Usage: /sidebar on|off|status" });
      return;
    }
    const shouldOpen = normalized === "on";
    if (this.sidebarOpen !== shouldOpen) this.toggleSidebar();
    else this.showNoticePopup(`Sidebar already ${shouldOpen ? "open" : "closed"}`, "success");
  }

  private abortActiveRequest(): void {
    this.bridge.stop();
    this.runActive = false;
    this.state.running = false;
    pushSystemLog(this.state, "Aborted active CrewCoder request.");
    this.showAbortPopup();
  }

  private approvalMode(): CrewCoderApprovalMode {
    return this.state.fullAccess ? "full-access" : "review";
  }

  private toggleFullAccess(): void {
    this.setFullAccess(this.state.fullAccess ? "off" : "on");
  }

  private setFullAccess(value: string): void {
    const normalized = value.trim().toLowerCase();
    if (normalized !== "on" && normalized !== "off") {
      this.state.blocks.push({ type: "error", text: "Usage: /full-access on|off" });
      return;
    }
    this.state.fullAccess = normalized === "on";
    this.state.blocks.push({
      type: "system",
      text: this.state.fullAccess
        ? "Full access enabled. Future tool calls in this session will bypass approval prompts, including dangerous commands."
        : "Full access disabled. Future mutating and dangerous tool calls will require approval."
    });
    this.showNoticePopup(this.state.fullAccess ? "⚠ Full access enabled" : "Full access disabled", this.state.fullAccess ? "warning" : "success");
  }

  private async setCheckpoints(value: string): Promise<void> {
    const normalized = value.trim().toLowerCase();
    if (normalized !== "on" && normalized !== "off" && normalized !== "status") {
      this.state.blocks.push({ type: "error", text: "Usage: /checkpoints on|off|status" });
      return;
    }
    if (normalized === "status") {
      const config = await readCrewCoderConfig();
      if (!config) {
        this.state.blocks.push({ type: "error", text: "Could not read checkpoint configuration." });
        return;
      }
      this.state.blocks.push({ type: "system", text: `Automatic checkpoints are ${config.checkpointsEnabled === false ? "off" : "on"}. Existing checkpoints are preserved.` });
      return;
    }
    if (this.bridge.running) {
      this.state.blocks.push({ type: "error", text: "Cannot change checkpoints while the model is running. Wait for the current response to finish." });
      return;
    }
    this.state.running = true;
    try {
      const { stderr, exitCode } = await execCrewCoderCommand(["config", "set", "checkpointsEnabled", normalized === "on" ? "true" : "false"]);
      if (exitCode !== 0) throw new Error(stderr.trim() || `Checkpoint configuration exited with code ${exitCode}.`);
      this.state.blocks.push({
        type: "system",
        text: `Automatic checkpoints turned ${normalized}. Existing checkpoints are preserved${normalized === "off" ? "; future runs will not create new ones" : ""}.`
      });
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private setTaskInstanceOverride(value: "on" | "off" | "status"): void {
    if (value === "status") {
      const override = process.env.CREWCODER_TASKS_ENABLED;
      this.state.blocks.push({
        type: "system",
        text: override === "true"
          ? "Tasks are on for this CrewCoder instance."
          : override === "false"
            ? "Tasks are off for this CrewCoder instance."
            : "Tasks use the shared default for this CrewCoder instance. Use /task on or /task off to override it locally."
      });
      return;
    }
    process.env.CREWCODER_TASKS_ENABLED = value === "on" ? "true" : "false";
    this.state.blocks.push({
      type: "system",
      text: `Tasks turned ${value} for this CrewCoder instance only. Other running instances and the shared default were not changed.`
    });
    this.showNoticePopup(`Tasks: ${value} (this instance)`, "success");
  }

  private setFileChangesDisplay(value: string): void {
    const normalized = value.trim().toLowerCase();
    if (normalized === "status") {
      this.state.blocks.push({ type: "system", text: `File changes display is ${this.state.showFileChanges ? "on" : "off"}. File tracking remains active.` });
      return;
    }
    if (normalized !== "on" && normalized !== "off") {
      this.state.blocks.push({ type: "error", text: "Usage: /file-changes on|off|status" });
      return;
    }
    this.state.showFileChanges = normalized === "on";
    this.state.blocks.push({
      type: "system",
      text: `File changes display turned ${normalized}. File tracking remains active${this.state.showFileChanges && this.state.changedFiles.length ? ` (${this.state.changedFiles.length} changed).` : "."}`
    });
    this.showNoticePopup(`File changes display: ${normalized}`, "success");
  }

  /**
   * `/set-budget 200k|off|status`. Token budgets are deliberately opt-in: this is
   * the only place a TUI session gets one, and it applies from the next run on.
   */
  private setTokenBudget(value: string): void {
    const normalized = value.trim().toLowerCase();

    if (!normalized || normalized === "status") {
      this.state.blocks.push({
        type: "system",
        text: this.state.tokenBudget
          ? `Token budget: ${formatBudgetTokens(this.state.tokenBudget)} tokens for this session. Clear it with /set-budget off.`
          : "No token budget set. This session is unbounded. Set one with /set-budget 200k."
      });
      return;
    }

    if (normalized === "off" || normalized === "none" || normalized === "0") {
      this.state.tokenBudget = undefined;
      this.state.usage = { ...this.state.usage, tokenBudget: undefined, budgetExceeded: undefined };
      this.state.blocks.push({ type: "system", text: "Token budget cleared. This session is unbounded again." });
      this.showNoticePopup("Token budget cleared", "success");
      return;
    }

    const parsed = parseBudgetInput(normalized);
    if (parsed === undefined) {
      this.state.blocks.push({ type: "error", text: "Usage: /set-budget 200k|1.5m|250000|off|status" });
      return;
    }

    this.state.tokenBudget = parsed;
    this.state.usage = { ...this.state.usage, tokenBudget: parsed };
    this.state.blocks.push({
      type: "system",
      text: `Token budget set to ${formatBudgetTokens(parsed)} tokens${this.state.sessionId ? " and applied from your next message" : ""}. A warning shows at 80%; the run stops at the limit.`
    });
    this.showNoticePopup(`Token budget: ${formatBudgetTokens(parsed)}`, "success");
  }

  private showExternalDirectories(mode: "add" | "remove"): void {
    if (mode === "add") {
      this.state.blocks.push({
        type: "system",
        text: this.state.externalDirectories.length
          ? `External directories:\n${this.state.externalDirectories.map((directory) => `- ${directory}`).join("\n")}\n\nAdd another with /add-dir <path>.`
          : "No external directories attached. Add one with /add-dir <path>."
      });
      return;
    }
    if (!this.state.externalDirectories.length) {
      this.state.blocks.push({ type: "system", text: "No external directories attached." });
      return;
    }
    this.openPanelPopover(new PickerOverlay("Remove external directory", this.state.externalDirectories.map((directory) => ({
      label: directory,
      value: directory
    })), (option) => {
      this.closeActivePopover();
      void this.removeExternalDirectory(option.value);
    }), Math.min(this.state.externalDirectories.length, 10) + 3);
  }

  private async addExternalDirectory(directory: string): Promise<void> {
    if (!directory) { this.state.blocks.push({ type: "error", text: "Usage: /add-dir <path>" }); return; }
    if (this.bridge.running || this.state.running) { this.state.blocks.push({ type: "error", text: "Cannot change external directories while CrewCoder is running. Use /stop first." }); return; }
    this.state.running = true;
    try {
      const args = this.state.sessionId && this.state.sessionId !== "new"
        ? ["session", "add-dir", this.state.sessionId, directory, "--json"]
        : ["session", "validate-dir", directory, "--json"];
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(args);
      if (exitCode !== 0) throw new Error(stderr || `add-dir exited with code ${exitCode}`);
      const parsed = JSON.parse(stdout || "null") as unknown;
      const directories = Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).path === "string"
          ? [...this.state.externalDirectories, (parsed as Record<string, unknown>).path as string]
          : [];
      this.state.externalDirectories = [...new Set(directories)];
      this.state.blocks.push({ type: "system", text: `External directory attached to this session: ${this.state.externalDirectories.at(-1) ?? directory}` });
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private async removeExternalDirectory(directory: string): Promise<void> {
    if (!directory) { this.state.blocks.push({ type: "error", text: "Usage: /remove-dir <path>" }); return; }
    if (this.bridge.running || this.state.running) { this.state.blocks.push({ type: "error", text: "Cannot change external directories while CrewCoder is running. Use /stop first." }); return; }
    const resolvedInput = path.resolve(this.state.cwd, directory);
    const target = this.state.externalDirectories.find((existing) => existing === directory || existing === resolvedInput);
    if (!target) { this.state.blocks.push({ type: "error", text: `External directory is not attached: ${directory}` }); return; }
    this.state.running = true;
    try {
      if (this.state.sessionId && this.state.sessionId !== "new") {
        const { stdout, stderr, exitCode } = await execCrewCoderCommand(["session", "remove-dir", this.state.sessionId, target, "--json"]);
        if (exitCode !== 0) throw new Error(stderr || `remove-dir exited with code ${exitCode}`);
        const parsed = JSON.parse(stdout || "[]") as unknown;
        this.state.externalDirectories = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
      } else {
        this.state.externalDirectories = this.state.externalDirectories.filter((existing) => existing !== target);
      }
      this.state.blocks.push({ type: "system", text: `External directory removed from this session: ${target}` });
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private async openGoalOverlay(): Promise<void> {
    const config = await readCrewCoderConfig();
    const defaults = config?.goals ?? { maxTurns: 200, timeoutMinutes: 480 };
    this.openPanelPopover(new GoalOverlay(defaults, this.state.provider, this.state.model, (draft) => {
      this.closeActivePopover();
      void this.executeGoalStart({ ...draft, disableCheckModel: !draft.checkModel });
    }), 13);
  }

  private async runGoalCommand(input: string): Promise<void> {
    this.forceConversationView = true;
    this.state.viewportScroll = 0;
    let parts: string[];
    try { parts = tokenizeGoalCommand(input); }
    catch (error) { this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) }); return; }
    const action = parts[0]?.toLowerCase();
    let args: string[];
    if (!action || action === "status") {
      args = ["goal", "status", ...(parts.slice(1)), "--json"];
    } else if (action === "list") {
      args = ["goal", "list", "--json"];
    } else if (action === "logs") {
      await this.showGoalLogs(parts[1]);
      return;
    } else if (action === "pause" || action === "clear" || action === "approve" || action === "deny") {
      args = ["goal", action, ...(parts.slice(1)), "--json"];
    } else if (action === "resume") {
      args = ["goal", "resume", ...(parts.slice(1)), "--approval", this.approvalMode(), "--json"];
    } else {
      try {
        const start = parseGoalStartInput(action === "start" ? parts.slice(1) : parts);
        await this.executeGoalStart(start);
      } catch (error) {
        this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    await this.executeGoalArgs(args);
  }

  private async executeGoalStart(start: GoalStartInput): Promise<void> {
    this.forceConversationView = true;
    this.state.viewportScroll = 0;
    const args = [
      "goal", "start", start.objective,
      "--provider", this.state.provider,
      "--model", this.state.model,
      "--mode", this.state.mode,
      "--effort", this.state.effort,
      "--approval", this.approvalMode(),
      "--json"
    ];
    if (start.maxTurns !== undefined) args.push("--max-turns", String(start.maxTurns));
    if (start.timeoutMinutes !== undefined) args.push("--timeout-minutes", String(start.timeoutMinutes));
    if (start.checkModel) args.push("--check-model", start.checkModel);
    else if (start.disableCheckModel) args.push("--no-check-model");
    if (this.state.tokenBudget) args.push("--budget", String(this.state.tokenBudget));
    if (this.state.systemPrompt) args.push("--system-prompt", this.state.systemPrompt);
    if (this.state.worker) args.push("--worker", this.state.worker);
    await this.executeGoalArgs(args);
  }

  private async executeGoalArgs(args: string[]): Promise<void> {
    this.state.running = true;
    try {
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(args);
      if (exitCode !== 0) {
        this.state.blocks.push({ type: "error", text: stderr || `Goal command exited with code ${exitCode}` });
        return;
      }
      const parsed: unknown = JSON.parse(stdout || "null");
      const records = Array.isArray(parsed) ? parsed : [parsed];
      const goals = records.flatMap((record) => {
        const goal = parseGoalRecord(JSON.stringify(record));
        return goal ? [goal] : [];
      });
      if (!goals.length) {
        this.state.blocks.push({ type: "system", text: "No goal found in this workspace. Start one with /goal." });
        return;
      }
      for (const goal of goals.slice(0, 10)) this.state.blocks.push({ type: "goal", goal });
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private async showGoalLogs(goalId?: string): Promise<void> {
    this.state.running = true;
    try {
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(["goal", "logs", ...(goalId ? [goalId] : [])]);
      if (exitCode !== 0) { this.state.blocks.push({ type: "error", text: stderr || `Goal logs exited with code ${exitCode}` }); return; }
      const lines = stdout.split("\n").filter(Boolean).slice(-30);
      this.state.blocks.push({ type: "system", text: lines.length ? `Recent goal events:\n${lines.join("\n")}` : "No goal events recorded yet." });
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private queueFollowUp(message: string): void {
    if (!message) {
      this.state.blocks.push({ type: "error", text: "Usage: /follow-up <message>" });
      return;
    }
    if (!this.bridge.running) {
      this.state.blocks.push({ type: "error", text: "No active CrewCoder run. Send a normal message to start or resume a session." });
      return;
    }
    if (!this.bridge.followUp(message)) {
      this.state.blocks.push({ type: "error", text: "Could not queue follow-up for the active run." });
      return;
    }
    this.forceConversationView = true;
    this.state.viewportScroll = 0;
    this.state.blocks.push({ type: "user", text: message, background: ["Queued follow-up for the running turn."] });
    pushSystemLog(this.state, "Queued follow-up for the running turn…");
  }

  private resolveApprovalCommand(approvalId: string, approved: boolean): void {
    const pending = approvalId || this.latestPendingApprovalId();
    if (!pending) {
      this.state.blocks.push({ type: "error", text: `No pending approval to ${approved ? "approve" : "deny"}.` });
      return;
    }
    if (!this.bridge.running) {
      this.state.blocks.push({ type: "error", text: "No active CrewCoder run is waiting for approval." });
      return;
    }
    const reason = approved ? "Approved from TUI control channel." : "Denied from TUI control channel.";
    if (!this.bridge.resolveApproval(pending, approved, reason)) {
      this.state.blocks.push({ type: "error", text: `Could not ${approved ? "approve" : "deny"} ${pending}.` });
      return;
    }
    if (this.activePopover?.kind === "approval" && this.activePopover.approvalId === pending) this.closeActivePopover();
    this.forceConversationView = true;
    this.state.viewportScroll = 0;
    pushSystemLog(this.state, `${approved ? "Approved" : "Denied"} ${pending}.`);
  }

  private latestPendingApprovalId(): string | undefined {
    for (let i = this.state.blocks.length - 1; i >= 0; i--) {
      const block = this.state.blocks[i];
      if (block?.type === "approval" && block.status === "pending" && block.id) return block.id;
    }
    return undefined;
  }

  private startNewSession(): void {
    this.bridge.stop();
    if (this.state.sessionId && this.state.sessionId !== "new") {
      this.sessionStore.deleteSession(this.state.sessionId);
    }
    this.liveUiController.disposeAll("session_end");
    this.runActive = false;
    this.state.sessionId = "new";
    this.state.blocks = [];
    this.state.changedFiles = [];
    this.state.running = false;
    this.state.viewportScroll = 0;
    this.state.viewportMaxScroll = 0;
    this.state.toolOutputExpanded = false;
    this.state.fullAccess = false;
    // Session grants never leak into a new chat.
    this.state.externalDirectories = [];
    // Budgets are opt-in per session, so a fresh session starts unbounded.
    this.state.tokenBudget = undefined;
    this.state.usage = { turns: 0 };
    this.state.systemPrompt = undefined;
    this.state.worker = undefined;
    this.state.liveUiFocus = undefined;
    this.pendingSkills = [];
    this.forceConversationView = false;
    pushSystemLog(this.state, "Started a new CrewCoder session.");
  }

  private async reloadCliMetadata(): Promise<void> {
    if (this.state.running || this.bridge.running) {
      this.state.blocks.push({ type: "error", text: "Cannot reload while CrewCoder is running. Use /stop first." });
      return;
    }

    this.state.running = true;
    try {
      const reload = await reloadCrewCoderHomeMetadata(() => this.loadProviders(), () => this.loadSessions());
      this.applyReloadedConfig(reload.config);
      this.refreshActiveProvider(reload.providers);
      void this.loadExtensionRenderers();
      void this.loadLiveUiContributions();
      const summary = isCrewCoderRemote()
        ? `remote ${this.state.remoteTarget ?? "SSH"}:${this.state.cwd}`
        : reload.home.exists
          ? `~/.crewcoder: ${reload.home.fileCount} file${reload.home.fileCount === 1 ? "" : "s"}${reload.home.latest ? ` · latest ${reload.home.latest}` : ""}`
          : "~/.crewcoder: not found";
      const details = [
        summary,
        `${reload.providers.length} provider${reload.providers.length === 1 ? "" : "s"}`,
        `${reload.sessions.length} session${reload.sessions.length === 1 ? "" : "s"}`
      ].join(" · ");
      this.state.blocks.push({ type: "system", text: `Reloaded CrewCoder home metadata. ${details}` });
      this.showNoticePopup("✓ Reloaded CrewCoder", "success");
    } catch (error) {
      this.state.blocks.push({ type: "error", text: `Reload failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      this.state.running = false;
    }
  }

  private applyReloadedConfig(config: CrewCoderReloadConfig | undefined): void {
    if (!config) return;
    if (config.integrationProfile) this.state.integrationProfile = config.integrationProfile;
    if (config.defaultMode !== undefined) {
      this.state.mode = normalizeTuiMode(config.defaultMode);
      if (this.state.mode === "plugin" && this.state.integrationProfile !== "crewcode") this.state.mode = "general";
    }
    if (config.defaultProvider) this.state.provider = config.defaultProvider;
    if (config.defaultModel) this.state.model = config.defaultModel;
    if (config.thinkingEnabled !== undefined) this.state.thinkingEnabled = config.thinkingEnabled;
    if (config.allowExtensionLiveUi !== undefined) {
      this.state.allowExtensionLiveUi = config.allowExtensionLiveUi;
      this.liveUiTrustGate.allowed = config.allowExtensionLiveUi;
    }
  }

  private refreshActiveProvider(providers: ProviderRecord[]): void {
    const provider = providers.find((item) => item.id === this.state.provider) ?? providers[0];
    if (!provider) return;
    this.state.provider = provider.id;
    if (provider.models.length && !provider.models.includes(this.state.model)) {
      this.state.model = provider.defaultModel ?? provider.models[0] ?? this.state.model;
    }
    const levels = effortLevelsForModel(this.state.provider, this.state.model);
    if (!levels.includes(this.state.effort)) this.state.effort = levels[0] ?? this.state.effort;
  }

  private runPrompt(prompt: string): void {
    // `bridge.run`/`bridge.resume` stop any lingering child from a finished run.
    this.runActive = true;
    this.state.viewportScroll = 0;
    const attachments = this.state.attachments;
    if (attachments.length && isCrewCoderRemote()) {
      this.state.blocks.push({ type: "error", text: "Local clipboard images cannot be sent through remote SSH mode yet. Clear the attachment with Ctrl+X and send the prompt again." });
      return;
    }
    const imagePaths = attachments.map((attachment) => attachment.path);
    this.state.blocks.push({ type: "user", text: prompt || "(image attached)" });
    // Render each pasted screenshot as a preview block under the user turn. The
    // pixels themselves reach vision-capable providers via --image (see below).
    for (const attachment of attachments) this.state.blocks.push({ type: "image", attachment });
    if (attachments.length) this.state.attachments = [];
    // Skills attached via /skills are prepended as context ahead of the user's
    // message, then cleared. The viewport still shows only the user's text.
    if (this.pendingSkills.length) {
      const skillBlocks = this.pendingSkills
        .map((skill) => `# Skill: ${skill.name}\n${skill.description}\n\n${skill.body}`)
        .join("\n\n");
      prompt = `The user attached the following skill(s). Follow their instructions when relevant to the request below.\n\n${skillBlocks}\n\n---\n\n${prompt}`;
      this.pendingSkills = [];
    }
    const onEvent = (event: Parameters<typeof applyCrewCoderEvent>[1]) => {
      this.handleCrewCoderEvent(event);
    };
    if (this.state.sessionId && this.state.sessionId !== "new") {
      this.bridge.resume({ sessionId: this.state.sessionId, prompt, provider: this.state.provider, mode: this.state.mode, worker: this.state.worker, model: this.state.model, systemPrompt: this.state.systemPrompt, effort: this.state.effort, cwd: this.state.cwd, approval: this.approvalMode(), budget: this.state.tokenBudget, images: imagePaths, externalDirectories: this.state.externalDirectories }, onEvent);
      return;
    }
    this.bridge.run({ prompt, provider: this.state.provider, mode: this.state.mode, worker: this.state.worker, model: this.state.model, systemPrompt: this.state.systemPrompt, effort: this.state.effort, cwd: this.state.cwd, approval: this.approvalMode(), budget: this.state.tokenBudget, images: imagePaths, externalDirectories: this.state.externalDirectories }, onEvent);
  }

  private openSessionsOverlay(): void {
    this.openPanelPopover(
      new SessionsOverlay((session) => {
        this.resumeSelectedSession(session);
      }, (session) => {
        void this.branchSession(session.id);
      }),
      16
    );
  }

  private resumeSelectedSession(session: SessionRecord): void {
    this.state.blocks = [];
    this.state.changedFiles = [];
    this.state.viewportScroll = 0;
    this.state.systemPrompt = undefined;
    this.state.worker = undefined;
    if (this.state.sessionId && this.state.sessionId !== "new") {
      this.sessionStore.deleteSession(this.state.sessionId);
    }
    this.liveUiController.disposeAll("session_end");
    if (session.provider) this.state.provider = session.provider;
    if (session.model) this.state.model = session.model;
    // Prefer the session's saved effort, but keep it valid for the provider/model we
    // are resuming onto: carrying an unsupported level (e.g. `xhigh` onto an
    // Anthropic model) would push a rejected value into the next request.
    const effortLevels = effortLevelsForModel(this.state.provider, this.state.model);
    this.state.effort = normalizeEffort(session.effort, effortLevels) ?? normalizeEffort(this.state.effort, effortLevels) ?? DEFAULT_EFFORT;
    this.state.externalDirectories = [...(session.externalDirectories ?? [])];
    const sessionMode = session.requestedMode || session.resolvedMode;
    if (sessionMode) this.state.mode = normalizeTuiMode(sessionMode);
    pushSystemLog(this.state, `Resuming session ${session.id} with ${this.state.provider}${this.state.model ? `/${this.state.model}` : ""} (${this.state.effort})`);
    this.state.sessionId = session.id;
    this.runActive = true;
    this.closeActivePopover();
    this.bridge.resume(
      { sessionId: session.id, provider: this.state.provider, mode: this.state.mode, model: this.state.model, systemPrompt: this.state.systemPrompt, effort: this.state.effort, cwd: this.state.cwd, approval: this.approvalMode(), budget: this.state.tokenBudget, externalDirectories: this.state.externalDirectories },
      (event) => this.handleCrewCoderEvent(event)
    );
  }

  private openBudgetReachedPopover(handoff: BudgetHandoff): void {
    this.pendingBudgetHandoff = handoff;
    this.forceConversationView = true;
    this.openPanelPopover(new PickerOverlay("Token budget reached", [
      { label: "Stay in this session", value: "stay", description: "Keep the exhausted session open without spending more tokens" },
      { label: "Handoff to a new session", value: "handoff", description: "Start fresh with only the compacted summary" }
    ], (option) => {
      if (option.value === "stay") {
        this.pendingBudgetHandoff = undefined;
        this.closeActivePopover();
        return;
      }
      void this.openBudgetProviderPicker(handoff);
    }), 8);
  }

  private async openBudgetProviderPicker(handoff: BudgetHandoff): Promise<void> {
    const providers = await this.loadProviders();
    this.openPanelPopover(new PickerOverlay("Handoff: pick provider", providers.map((provider) => ({
      label: provider.id,
      value: provider.id,
      description: provider.description ?? provider.title
    })), (option) => {
      const provider = providers.find((item) => item.id === option.value);
      this.state.provider = option.value;
      this.openBudgetModelPicker(handoff, provider);
    }), 10);
  }

  private openBudgetModelPicker(handoff: BudgetHandoff, provider?: ProviderRecord): void {
    const resolved = resolveProviderRecord(this.state.provider, provider);
    const models = resolved.models.length ? resolved.models : [this.state.model];
    this.openPanelPopover(new PickerOverlay("Handoff: pick model", models.map((model) => ({
      label: model,
      value: model,
      description: model === resolved.defaultModel ? "default" : undefined
    })), (option) => {
      this.state.model = option.value;
      const levels = effortLevelsForModel(this.state.provider, this.state.model);
      if (!levels.includes(this.state.effort)) this.state.effort = levels[0] ?? this.state.effort;
      this.openPanelPopover(new EffortOverlay(this.state.provider, this.state.model, this.state.effort, (effort) => {
        this.state.effort = effort;
        this.closeActivePopover();
        this.launchBudgetHandoff(handoff);
      }), 8);
    }), 18);
  }

  private launchBudgetHandoff(handoff: BudgetHandoff): void {
    this.pendingBudgetHandoff = undefined;
    // startNewSession() clears the budget, but this handoff exists *because* a
    // budget was hit. Carry it into the child so the child gets a fresh
    // allowance of the same size rather than silently becoming unbounded.
    const inheritedBudget = this.state.tokenBudget;
    this.startNewSession();
    this.state.tokenBudget = inheritedBudget;
    if (inheritedBudget) this.state.usage = { ...this.state.usage, tokenBudget: inheritedBudget };
    this.forceConversationView = true;
    const prompt = `Continue from this compacted handoff summary only. Do not assume access to the original transcript.\n\n${handoff.summary}`;
    this.state.blocks.push({ type: "user", text: `Handoff from ${handoff.sourceSessionId}\n\n${handoff.summary}` });
    this.runActive = true;
    this.bridge.run({
      prompt,
      provider: this.state.provider,
      mode: this.state.mode,
      worker: this.state.worker,
      model: this.state.model,
      systemPrompt: this.state.systemPrompt,
      effort: this.state.effort,
      cwd: this.state.cwd,
      approval: this.approvalMode(),
      budget: this.state.tokenBudget,
      parentSessionId: handoff.sourceSessionId
    }, (event) => this.handleCrewCoderEvent(event));
  }

  private async openProviderOverlay(): Promise<void> {
    const providers = await this.loadProviders();
    this.openPanelPopover(
      new PickerOverlay("Pick provider", providers.map((provider) => ({
        label: provider.id,
        value: provider.id,
        description: provider.description ?? provider.title
      })), (option) => {
        const provider = providers.find((item) => item.id === option.value);
        this.state.provider = option.value;
        pushSystemLog(this.state, `Provider set to ${this.state.provider}`);
        this.openModelPicker(option.value, provider);
      }),
      10
    );
  }

  private openModesOverlay(): void {
    // Open immediately with built-in modes (+ any cached workers) so the picker
    // appears with no spawn delay, then refresh worker entries asynchronously.
    this.showModesOverlay(this.cachedWorkers);
    void this.refreshModesOverlay();
  }

  private showModesOverlay(workers: Array<{ name: string; active: boolean; ownerName: string | null }>): void {
    const builtinModes: PickerOption[] = [
      { label: !this.state.worker && this.state.mode === "general" ? "* general" : "general", value: "general", description: "General coding agent mode" },
      ...(this.state.integrationProfile === "crewcode" ? [{ label: !this.state.worker && this.state.mode === "plugin" ? "* plugin" : "plugin", value: "plugin", description: "CrewCode app plugin architect mode" }] : []),
      { label: !this.state.worker && this.state.mode === "extension" ? "* extension" : "extension", value: "extension", description: "CrewCoder extension architect mode" }
    ];
    const activeWorkerName = this.state.worker ?? workers.find((worker) => worker.active)?.name;
    const workerOptions: PickerOption[] = workers.map((worker) => ({
      label: worker.name === activeWorkerName ? `* ${worker.name}` : worker.name,
      value: worker.name,
      description: worker.ownerName ? `worker · owner: ${worker.ownerName}` : "worker"
    }));
    const options = [...builtinModes, ...workerOptions];
    this.openPanelPopover(
      new PickerOverlay("Pick mode or worker", options, (option) => {
        this.closeActivePopover();
        void this.selectModeOrWorker(option.value);
      }),
      Math.min(Math.max(options.length, 1), 12) + 3,
      "agents"
    );
  }

  private async refreshModesOverlay(): Promise<void> {
    const workers = await this.listWorkers();
    this.cachedWorkers = workers;
    if (this.activePopover?.kind === "agents") this.showModesOverlay(workers);
  }

  private async listWorkers(): Promise<Array<{ name: string; active: boolean; ownerName: string | null }>> {
    try {
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(["workers", "list", "--json"]);
      if (exitCode !== 0) throw new Error(stderr || `workers list exited with code ${exitCode}`);
      return JSON.parse(stdout || "[]") as Array<{ name: string; active: boolean; ownerName: string | null }>;
    } catch {
      return [];
    }
  }

  private async selectModeOrWorker(name: string): Promise<void> {
    const value = name.trim();
    if (!value) return;
    if (isTuiMode(value)) {
      if (value === "plugin" && this.state.integrationProfile !== "crewcode") { this.crewCodeDisabledNotice(); return; }
      this.state.mode = value;
      this.state.worker = undefined;
      pushSystemLog(this.state, `Mode set to ${this.state.mode}`);
      return;
    }
    let workers = this.cachedWorkers;
    if (!workers.some((entry) => entry.name === value)) {
      workers = await this.listWorkers();
      this.cachedWorkers = workers;
    }
    if (!workers.some((entry) => entry.name === value)) {
      this.state.blocks.push({ type: "error", text: `Worker not found: ${value}` });
      return;
    }
    // Per-session only: passed as --worker on each run, never mutates the global active worker.
    this.state.worker = value;
    pushSystemLog(this.state, `Worker set to ${value} (this session only)`);
  }

  private async openModelOverlay(): Promise<void> {
    const providers = await this.loadProviders();
    const provider = providers.find((item) => item.id === this.state.provider);
    this.openModelPicker(this.state.provider, provider);
  }

  private openModelPicker(providerId = this.state.provider, provider?: ProviderRecord): void {
    const resolvedProvider = resolveProviderRecord(providerId, provider);
    const models = resolvedProvider.models.length ? resolvedProvider.models : [this.state.model];
    this.openPanelPopover(
      new PickerOverlay("Pick model", models.map((model) => ({
        label: model,
        value: model,
        description: model === resolvedProvider.defaultModel ? "default" : undefined
      })), (option) => {
        this.state.model = option.value;
        const levels = effortLevelsForModel(this.state.provider, this.state.model);
        if (!levels.includes(this.state.effort)) this.state.effort = levels[0] ?? this.state.effort;
        pushSystemLog(this.state, `Model set to ${this.state.model}`);
        this.openEffortOverlay();
      }),
      18
    );
  }

  private openEffortOverlay(): void {
    this.openPanelPopover(
      new EffortOverlay(this.state.provider, this.state.model, this.state.effort, (effort) => {
        this.state.effort = effort;
        pushSystemLog(this.state, `Reasoning effort set to ${effort}`);
        this.closeActivePopover();
      }),
      8
    );
  }

  private async setThinking(value: string): Promise<void> {
    const normalized = value.trim().toLowerCase();
    if (normalized === "status" || !normalized) {
      this.state.blocks.push({ type: "system", text: `Provider thinking is ${this.state.thinkingEnabled ? "on" : "off"}.` });
      return;
    }
    if (normalized !== "on" && normalized !== "off") {
      this.state.blocks.push({ type: "error", text: "Usage: /thinking on|off|status" });
      return;
    }
    const { stderr, exitCode } = await execCrewCoderCommand(["config", "set", "thinkingEnabled", normalized === "on" ? "true" : "false"]);
    if (exitCode !== 0) {
      this.state.blocks.push({ type: "error", text: stderr.trim() || "Could not update thinking setting." });
      return;
    }
    this.state.thinkingEnabled = normalized === "on";
    this.state.blocks.push({ type: "system", text: `Provider thinking turned ${normalized}.` });
  }

  private setEffort(value: string): void {
    const levels = effortLevelsForModel(this.state.provider, this.state.model);
    const effort = normalizeEffort(value, levels);
    if (!effort) {
      this.state.blocks.push({ type: "error", text: `Effort must be one of: ${levels.join(", ")}` });
      return;
    }
    this.state.effort = effort;
    pushSystemLog(this.state, `Reasoning effort set to ${effort}`);
  }

  private async openSkillsOverlay(): Promise<void> {
    let skills: Array<{ name: string; description: string }>;
    try {
      skills = await this.listSkills();
    } catch (error) {
      this.state.blocks.push({ type: "error", text: `Failed to list skills: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (!skills.length) { pushSystemLog(this.state, "No skills found in ~/.crewcoder/skills/."); return; }
    const options: PickerOption[] = skills.map((skill) => ({ label: skill.name, value: skill.name, description: skill.description }));
    this.openPanelPopover(
      new PickerOverlay("Attach a skill", options, (option) => {
        this.closeActivePopover();
        void this.attachSkillByName(option.value);
      }),
      Math.min(Math.max(options.length, 1), 12) + 3,
      "agents"
    );
  }

  private async openSystemPromptsOverlay(): Promise<void> {
    let prompts: SystemPromptSummary[];
    try {
      prompts = await this.listSystemPrompts();
    } catch (error) {
      this.state.blocks.push({ type: "error", text: `Failed to list system prompts: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (!prompts.length) { pushSystemLog(this.state, "No system prompts found in ~/.crewcoder/system-prompts/."); return; }
    const options: PickerOption[] = prompts.map((prompt) => ({
      label: prompt.name === this.state.systemPrompt ? `* ${prompt.name}` : prompt.name,
      value: prompt.name,
      description: prompt.path
    }));
    this.openPanelPopover(
      new PickerOverlay("Select system prompt", options, (option) => {
        this.closeActivePopover();
        void this.selectSystemPromptByName(option.value);
      }),
      Math.min(Math.max(options.length, 1), 12) + 3,
      "agents"
    );
  }

  private async listSystemPrompts(): Promise<SystemPromptSummary[]> {
    const { stdout, stderr, exitCode } = await execCrewCoderCommand(["system-prompt", "list", "--json"]);
    if (exitCode !== 0) throw new Error(stderr || `system-prompt list exited with code ${exitCode}`);
    return JSON.parse(stdout || "[]") as SystemPromptSummary[];
  }

  private async selectSystemPromptByName(name: string): Promise<void> {
    if (!name) return;
    this.state.running = true;
    try {
      const { stderr, exitCode } = await execCrewCoderCommand(["system-prompt", "show", name, "--json"]);
      if (exitCode !== 0) { this.state.blocks.push({ type: "error", text: `System prompt not found: ${name} (${stderr || "no output"})` }); return; }
      this.state.systemPrompt = name;
      this.forceConversationView = true;
      this.state.viewportScroll = 0;
      this.state.blocks.push({ type: "system", text: `System prompt selected: ${name}` });
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private async openPromptCommandsOverlay(): Promise<void> {
    let commands: PromptCommandSummary[];
    try {
      commands = await this.listPromptCommands();
    } catch (error) {
      this.state.blocks.push({ type: "error", text: `Failed to list prompt commands: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (!commands.length) { pushSystemLog(this.state, "No prompt commands found in ~/.crewcoder/commands/."); return; }
    const options: PickerOption[] = commands.map((command) => ({
      label: command.name,
      value: command.name,
      description: command.path
    }));
    this.openPanelPopover(
      new PickerOverlay("Insert command prompt", options, (option) => {
        this.closeActivePopover();
        void this.insertPromptCommandByName(option.value);
      }),
      Math.min(Math.max(options.length, 1), 12) + 3,
      "agents"
    );
  }

  private async listPromptCommands(): Promise<PromptCommandSummary[]> {
    const { stdout, stderr, exitCode } = await execCrewCoderCommand(["command", "list", "--json"]);
    if (exitCode !== 0) throw new Error(stderr || `command list exited with code ${exitCode}`);
    return JSON.parse(stdout || "[]") as PromptCommandSummary[];
  }

  private async insertPromptCommandByName(name: string, args: string[] = []): Promise<void> {
    if (!name) return;
    this.state.running = true;
    try {
      const commandArgs = ["command", "show", name, "--json", ...(args.length ? ["--arg", ...args] : [])];
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(commandArgs);
      if (exitCode !== 0 || !stdout.trim()) { this.state.blocks.push({ type: "error", text: `Prompt command not found: ${name} (${stderr || "no output"})` }); return; }
      const command = JSON.parse(stdout) as LoadedPromptCommand;
      this.state.input = command.content.trimEnd();
      this.state.inputCursor = this.state.input.length;
      this.forceConversationView = false;
      if (command.missingArguments?.length) pushSystemLog(this.state, `Missing command args: ${command.missingArguments.join(", ")}`);
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private parsePromptCommandInput(input: string): { name: string; args: string[] } {
    const parts = input.split(/\s+/).filter(Boolean);
    return { name: parts[0] ?? "", args: parts.slice(1) };
  }

  private parseDirectExtensionCommand(input: string): { name: string; args: string[] } {
    const parts = input.replace(/^\//, "").split(/\s+/).filter(Boolean);
    return { name: parts[0] ?? "", args: parts.slice(1) };
  }

  private async listSkills(): Promise<Array<{ name: string; description: string }>> {
    const { stdout, stderr, exitCode } = await execCrewCoderCommand(["skill", "list", "--json"]);
    if (exitCode !== 0) throw new Error(stderr || `skill list exited with code ${exitCode}`);
    return JSON.parse(stdout || "[]") as Array<{ name: string; description: string }>;
  }

  private async attachSkillByName(name: string): Promise<void> {
    if (!name) return;
    this.state.running = true;
    try {
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(["skill", "show", name, "--json"]);
      if (exitCode !== 0 || !stdout.trim()) { this.state.blocks.push({ type: "error", text: `Skill not found: ${name} (${stderr || "no output"})` }); return; }
      const skill = JSON.parse(stdout) as LoadedSkill;
      // Always surface a visible confirmation and drop out of the home screen
      // into the conversation view, regardless of the system-log env gate.
      this.forceConversationView = true;
      this.state.viewportScroll = 0;
      if (this.pendingSkills.some((s) => s.name === skill.name)) {
        this.state.blocks.push({ type: "system", text: `Skill already loaded: ${skill.name} — attached to your next message.` });
        return;
      }
      this.pendingSkills.push(skill);
      this.state.blocks.push({ type: "system", text: `Skill loaded: ${skill.name} — attached to your next message. (${this.pendingSkills.length} attached)` });
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private async showReviewSummary(): Promise<void> {
    this.state.running = true;
    this.forceConversationView = true;
    try {
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(["git", "review-summary", "--json"]);
      if (exitCode !== 0) {
        this.state.blocks.push({ type: "error", text: stderr || `review-summary exited with code ${exitCode}` });
        return;
      }
      this.state.blocks.push({ type: "review_summary", summary: parseReviewSummary(stdout) });
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  /**
   * `/why` — ask the model to explain its last decision. This runs as a separate
   * one-shot `session why` call rather than a prompt in the session, so asking
   * for an explanation never adds turns to the transcript the agent is working in.
   */
  private async explainLastDecision(): Promise<void> {
    if (!this.state.sessionId || this.state.sessionId === "new") {
      this.state.blocks.push({ type: "error", text: "Nothing to explain yet: this session has no agent turn." });
      return;
    }
    this.state.running = true;
    this.forceConversationView = true;
    try {
      const args = ["session", "why", this.state.sessionId, "--json", "--provider", this.state.provider, "--effort", this.state.effort];
      if (this.state.model) args.push("--model", this.state.model);
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(args);
      if (exitCode !== 0) {
        this.state.blocks.push({ type: "error", text: stderr || `session why exited with code ${exitCode}` });
        return;
      }
      const decision = parseDecisionExplanation(stdout);
      if (!decision) {
        this.state.blocks.push({ type: "error", text: "Nothing to explain yet: this session has no agent turn." });
        return;
      }
      this.state.blocks.push({ type: "why", decision });
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private openCrewCodeDetectionPrompt(markers: string[]): void {
    const markerText = markers.join(", ");
    this.openPanelPopover(new PickerOverlay("CrewCode project detected", [
      { label: "Enable CrewCode integration", value: "enable", description: markerText },
      { label: "Keep standalone", value: "dismiss", description: "Do not ask again for this project" }
    ], (option) => {
      this.closeActivePopover();
      if (option.value === "enable") void this.setIntegrationProfile("crewcode");
      else void this.dismissCrewCodeProfileSuggestion();
    }), 7);
  }

  private async dismissCrewCodeProfileSuggestion(): Promise<void> {
    const { stderr, exitCode } = await execCrewCoderCommand(["profile", "dismiss"]);
    if (exitCode !== 0) this.state.blocks.push({ type: "error", text: stderr || `Profile dismissal exited with code ${exitCode}` });
    else this.state.blocks.push({ type: "system", text: "Keeping standalone mode for this project." });
  }

  private openIntegrationProfilePicker(): void {
    const options: PickerOption[] = [
      { label: this.state.integrationProfile === "standalone" ? "* standalone" : "standalone", value: "standalone", description: "Coding agent without CrewCode desktop compatibility" },
      { label: this.state.integrationProfile === "crewcode" ? "* crewcode" : "crewcode", value: "crewcode", description: "Enable CrewCode plugins, mode, tools, and UI compatibility" }
    ];
    this.openPanelPopover(new PickerOverlay("Integration profile", options, (option) => {
      this.closeActivePopover();
      void this.setIntegrationProfile(option.value);
    }), 6);
  }

  private async setIntegrationProfile(value: string): Promise<void> {
    const profile = value.trim().toLowerCase();
    if (profile !== "standalone" && profile !== "crewcode") {
      this.state.blocks.push({ type: "error", text: "Usage: /profile standalone|crewcode" });
      return;
    }
    this.state.running = true;
    try {
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(["profile", "use", profile, "--project"]);
      if (exitCode !== 0) throw new Error(stderr || `Profile command exited with code ${exitCode}`);
      this.state.integrationProfile = profile;
      if (profile === "standalone" && this.state.mode === "plugin") this.state.mode = "general";
      this.commands.setItems(builtinPaletteItems(profile));
      this.state.blocks.push({ type: "system", text: stdout.trim() || `Project integration profile set to ${profile}.` });
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private crewCodeDisabledNotice(): void {
    this.state.blocks.push({ type: "error", text: "CrewCode integration is disabled for this project. Enable it with: /profile crewcode" });
  }

  private crewRunOptions(): string[] {
    const args = ["--provider", this.state.provider, "--mode", this.state.mode, "--effort", this.state.effort, "--approval", this.approvalMode()];
    if (this.state.model) args.push("--model", this.state.model);
    if (this.state.systemPrompt) args.push("--system-prompt", this.state.systemPrompt);
    return args;
  }

  private async openHandoffWorkerPicker(): Promise<void> {
    if (!this.state.sessionId || this.state.sessionId === "new") {
      this.state.blocks.push({ type: "error", text: "Start or resume a saved session before handing it off." });
      return;
    }
    const workers = await this.listWorkers();
    if (!workers.length) {
      this.state.blocks.push({ type: "error", text: "No workers found. Create one with: crewcoder workers create <name>" });
      return;
    }
    this.openPanelPopover(new PickerOverlay("Handoff to worker", workers.map((worker) => ({
      label: worker.name,
      value: worker.name,
      description: worker.ownerName ? `owner: ${worker.ownerName}` : "worker"
    })), (option) => {
      this.closeActivePopover();
      void this.runWorkerHandoff(option.value);
    }), Math.min(workers.length, 12) + 3);
  }

  private async runWorkerHandoff(input: string): Promise<void> {
    if (!this.state.sessionId || this.state.sessionId === "new") {
      this.state.blocks.push({ type: "error", text: "Start or resume a saved session before handing it off." });
      return;
    }
    const match = input.match(/^(?:worker:)?([^\s]+)(?:\s+([\s\S]+))?$/);
    if (!match) {
      this.state.blocks.push({ type: "error", text: "Usage: /handoff worker:<name> [continuation prompt]" });
      return;
    }
    const worker = match[1]!;
    const prompt = match[2]?.trim();
    const sourceSessionId = this.state.sessionId;
    const args = ["crew", "handoff", `worker:${worker}`, sourceSessionId];
    if (prompt) args.push(prompt);
    args.push(...this.crewRunOptions(), "--json");
    this.state.running = true;
    pushSystemLog(this.state, `Handing off ${sourceSessionId} to ${worker}…`);
    try {
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(args);
      if (exitCode !== 0) throw new Error(stderr || `Handoff exited with code ${exitCode}`);
      const result = JSON.parse(stdout) as { sessionId?: string; worker?: string; summary?: string };
      if (!result.sessionId) throw new Error("Handoff completed without a new session id.");
      this.state.sessionId = result.sessionId;
      this.state.worker = result.worker ?? worker;
      this.state.blocks = [];
      this.state.changedFiles = [];
      this.state.viewportScroll = 0;
      pushSystemLog(this.state, `Handoff complete: ${sourceSessionId} → ${result.sessionId} as ${this.state.worker}.`);
      if (result.summary) this.state.blocks.push({ type: "assistant", text: result.summary });
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private async runWorkerCrewCommand(input: string): Promise<void> {
    const match = input.match(/^(\S+)\s+([\s\S]+)$/);
    if (!match) {
      this.state.blocks.push({ type: "error", text: "Usage: /crew <worker1,worker2> <task>" });
      return;
    }
    await this.runCliCommand(["crew", "run", "--workers", match[1]!, match[2]!.trim(), ...this.crewRunOptions()]);
  }

  private async runWorkerTeamCommand(input: string): Promise<void> {
    const match = input.match(/^(\S+)\s+([\s\S]+)$/);
    if (!match) {
      this.state.blocks.push({ type: "error", text: "Usage: /team <team> <task> (use /teams to list teams)" });
      return;
    }
    await this.runCliCommand(["crew", "team", "run", match[1]!, match[2]!.trim(), ...this.crewRunOptions()]);
  }

  private async runCliCommand(args: string[]): Promise<void> {
    this.state.running = true;
    try {
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(args);
      if (stdout) {
        for (const line of stdout.split("\n")) {
          if (line.trim()) pushSystemLog(this.state, line.trim());
        }
      }
      if (stderr) {
        for (const line of stderr.split("\n")) {
          if (line.trim()) this.state.blocks.push({ type: "error", text: line.trim() });
        }
      }
      if (exitCode !== 0) {
        this.state.blocks.push({ type: "error", text: `Command exited with code ${exitCode}` });
      }
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private async branchCurrentSession(): Promise<void> {
    if (!this.state.sessionId || this.state.sessionId === "new") {
      this.state.blocks.push({ type: "error", text: "No saved session to branch yet." });
      return;
    }
    await this.branchSession(this.state.sessionId);
  }

  private openRewindPicker(): void {
    if (!this.state.checkpoints.length) {
      this.state.blocks.push({ type: "error", text: "No checkpoint found. Run a mutating tool first, then use /rewind latest or /rewind <checkpointId>." });
      return;
    }
    if (this.state.checkpoints.length === 1) {
      void this.rewindCurrentSession(this.state.checkpoints[0]!.id);
      return;
    }
    const options = [...this.state.checkpoints].reverse().map((checkpoint) => ({
      label: checkpoint.id,
      value: checkpoint.id,
      description: `${checkpoint.toolName ?? "checkpoint"} · ${checkpoint.fileCount} files · ${checkpoint.reason}`
    }));
    this.openPanelPopover(new PickerOverlay("Rewind to checkpoint", options, (option) => {
      this.closeActivePopover();
      void this.rewindCurrentSession(option.value);
    }), 14);
  }

  private async rewindCurrentSession(target: string): Promise<void> {
    this.forceConversationView = true;
    if (this.bridge.running) {
      this.state.blocks.push({ type: "error", text: "Cannot rewind while the model is running. Wait for the current response to finish." });
      return;
    }
    if (this.state.running) {
      this.state.blocks.push({ type: "error", text: "Cannot rewind while another CrewCoder command is running." });
      return;
    }
    if (!this.state.sessionId || this.state.sessionId === "new") {
      this.state.blocks.push({ type: "error", text: "No saved session to rewind yet." });
      return;
    }
    const checkpointId = this.resolveCheckpointId(target);
    if (!checkpointId) {
      this.state.blocks.push({ type: "error", text: "No checkpoint found. Run a mutating tool first, then use /rewind latest or /rewind <checkpointId>." });
      return;
    }
    this.state.running = true;
    pushSystemLog(this.state, `Rewinding ${this.state.sessionId} to ${checkpointId}…`);
    try {
      const previewResult = await execCrewCoderCommand(["session", "rewind-preview", this.state.sessionId, checkpointId, "--json"]);
      if (previewResult.exitCode !== 0) {
        this.state.blocks.push({ type: "error", text: previewResult.stderr.trim() || `Rewind preview exited with code ${previewResult.exitCode}.` });
        return;
      }
      const preview = parseRewindPreviewResult(previewResult.stdout);
      this.renderRewindPreview(checkpointId, preview);
      if (preview.deleteFiles.length > 0) {
        this.state.running = false;
        this.confirmRewindWithDeletes(checkpointId, preview.deleteFiles.length);
        return;
      }
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(["session", "rewind", this.state.sessionId, checkpointId, "--json"]);
      if (exitCode !== 0) {
        this.state.blocks.push({ type: "error", text: stderr.trim() || `Rewind command exited with code ${exitCode}.` });
        return;
      }
      const parsed = parseRewindResult(stdout);
      pushSystemLog(this.state, `Rewound to ${checkpointId}: restored ${parsed.restoredFiles} files, deleted ${parsed.deletedFiles} files.`);
      this.showNoticePopup("↶ Rewound workspace", "success");
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private renderRewindPreview(checkpointId: string, preview: RewindPreviewCliResult): void {
    this.state.blocks.push({ type: "system", text: `Rewind preview ${checkpointId}: restore ${preview.restoreFiles.length} files (${preview.changedFiles.length} changed, ${preview.missingFiles.length} missing), delete ${preview.deleteFiles.length} files.` });
    for (const file of preview.restoreFiles.slice(0, 5)) this.state.blocks.push({ type: "system", text: `  restore ${file}` });
    for (const file of preview.deleteFiles.slice(0, 5)) this.state.blocks.push({ type: "system", text: `  delete ${file}` });
    for (const diff of preview.diffs.slice(0, 2)) {
      this.state.blocks.push({ type: "checkpoint_diff", checkpointId, path: diff.path, lines: diff.lines.slice(0, 12), truncated: diff.truncated });
    }
  }

  private confirmRewindWithDeletes(checkpointId: string, deleteCount: number): void {
    this.openPanelPopover(new PickerOverlay(`Rewind deletes ${deleteCount} files`, [
      { label: "Cancel", value: "cancel", description: "Do not restore this checkpoint" },
      { label: "Restore anyway", value: "restore", description: `Restore ${checkpointId} and delete new files` }
    ], (option) => {
      this.closeActivePopover();
      if (option.value === "restore") void this.runRewindRestore(checkpointId);
      else pushSystemLog(this.state, "Rewind cancelled.");
    }), 10);
  }

  private async runRewindRestore(checkpointId: string): Promise<void> {
    if (!this.state.sessionId || this.state.sessionId === "new") return;
    this.state.running = true;
    try {
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(["session", "rewind", this.state.sessionId, checkpointId, "--json"]);
      if (exitCode !== 0) {
        this.state.blocks.push({ type: "error", text: stderr.trim() || `Rewind command exited with code ${exitCode}.` });
        return;
      }
      const parsed = parseRewindResult(stdout);
      pushSystemLog(this.state, `Rewound to ${checkpointId}: restored ${parsed.restoredFiles} files, deleted ${parsed.deletedFiles} files.`);
      this.showNoticePopup("↶ Rewound workspace", "success");
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private resolveCheckpointId(target: string): string | undefined {
    const trimmed = target.trim();
    if (!trimmed || trimmed === "latest") return this.state.checkpoints.at(-1)?.id;
    return trimmed;
  }

  private async compactCurrentSession(): Promise<void> {
    this.forceConversationView = true;
    if (this.bridge.running) {
      this.state.blocks.push({
        type: "compaction",
        status: "skipped",
        percent: 100,
        message: "Cannot compact while the model is running. Wait for the current response to finish, then run /compact."
      });
      return;
    }
    if (this.state.running) {
      this.state.blocks.push({
        type: "compaction",
        status: "skipped",
        percent: 100,
        message: "Cannot compact while another CrewCoder command is running. Try again when it finishes."
      });
      return;
    }
    if (!this.state.sessionId || this.state.sessionId === "new") {
      this.state.blocks.push({ type: "error", text: "No saved session to compact yet. Send a prompt first, then run /compact after it finishes." });
      return;
    }
    const args = ["session", "compact", this.state.sessionId, "--provider", this.state.provider, "--json"];
    if (this.state.model) args.push("--model", this.state.model);
    if (this.state.effort) args.push("--effort", this.state.effort);
    const block: Extract<TuiEventBlock, { type: "compaction" }> = {
      type: "compaction",
      status: "running",
      percent: 15,
      message: `Compacting saved session ${this.state.sessionId}…`
    };
    this.state.blocks.push(block);
    this.state.running = true;
    try {
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(args);
      if (exitCode !== 0) {
        block.status = "failed";
        block.percent = 100;
        block.message = stderr.trim() || `Compaction command exited with code ${exitCode}.`;
        return;
      }
      const result = parseCompactionResult(stdout);
      if (!result.compacted) {
        block.status = "skipped";
        block.percent = 100;
        block.message = "Nothing to compact yet — this session is still too small.";
        return;
      }
      block.status = "done";
      block.percent = 100;
      block.originalMessageCount = result.originalMessageCount;
      block.retainedMessageCount = result.retainedMessageCount;
      block.message = `Saved session ${this.state.sessionId} compacted.`;
    } catch (error) {
      block.status = "failed";
      block.percent = 100;
      block.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.state.running = false;
    }
  }

  private startCompactionPreview(): void {
    this.forceConversationView = true;
    // Live run: ask the running backend to compact-with-preview; the
    // session_compaction_preview event opens the editor overlay.
    if (this.bridge.running) {
      if (!this.bridge.requestCompactionPreview()) {
        pushSystemLog(this.state, "No active CrewCoder run to preview compaction for.");
      } else {
        pushSystemLog(this.state, "Requested compaction preview; waiting for the summary…");
      }
      return;
    }
    void this.previewSavedCompaction();
  }

  private async previewSavedCompaction(): Promise<void> {
    if (this.state.running) {
      pushSystemLog(this.state, "Cannot preview compaction while a command is running. Try again when it finishes.");
      return;
    }
    if (!this.state.sessionId || this.state.sessionId === "new") {
      this.state.blocks.push({ type: "error", text: "No saved session to preview yet. Send a prompt first, then run /compact preview." });
      return;
    }
    const sessionId = this.state.sessionId;
    const args = ["session", "compact", sessionId, "--preview", "--provider", this.state.provider, "--json"];
    if (this.state.model) args.push("--model", this.state.model);
    if (this.state.effort) args.push("--effort", this.state.effort);
    this.state.running = true;
    try {
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(args);
      if (exitCode !== 0) {
        this.state.blocks.push({ type: "error", text: stderr.trim() || `Compaction preview exited with code ${exitCode}.` });
        return;
      }
      const parsed = JSON.parse(stdout || "{}") as Record<string, unknown>;
      if (parsed.preview !== true || typeof parsed.summary !== "string") {
        pushSystemLog(this.state, "Nothing to preview yet — this session is still too small to compact.");
        return;
      }
      this.openCompactionPreviewOverlay({
        title: "Edit compaction summary",
        summary: parsed.summary,
        source: typeof parsed.source === "string" ? parsed.source : undefined,
        originalMessageCount: typeof parsed.originalMessageCount === "number" ? parsed.originalMessageCount : undefined,
        retainedMessageCount: typeof parsed.retainedMessageCount === "number" ? parsed.retainedMessageCount : undefined
      }, { mode: "idle", sessionId });
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private async exportCurrentSession(outPath?: string): Promise<void> {
    this.forceConversationView = true;
    if (!this.state.sessionId || this.state.sessionId === "new") {
      this.state.blocks.push({ type: "error", text: "No saved session to export yet. Send a prompt first, then run /export." });
      return;
    }
    const target = outPath && outPath.trim() ? outPath.trim() : `${this.state.sessionId}.html`;
    const args = ["session", "export", this.state.sessionId, "--html", "--out", target];
    this.state.running = true;
    try {
      const { stdout, stderr, exitCode } = await execCrewCoderCommand(args);
      if (exitCode !== 0) {
        this.state.blocks.push({ type: "error", text: stderr.trim() || `Export exited with code ${exitCode}.` });
        return;
      }
      pushSystemLog(this.state, stdout.trim() || `Exported session ${this.state.sessionId} to ${target}`);
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private async branchSession(sessionId: string): Promise<void> {
    this.state.running = true;
    try {
      const branchedId = await branchCrewCoderSession(sessionId);
      this.state.sessionId = branchedId || this.state.sessionId;
      pushSystemLog(this.state, `Branched session ${sessionId} -> ${this.state.sessionId}`);
      this.closeActivePopover();
    } catch (error) {
      this.state.blocks.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.state.running = false;
    }
  }

  private async loadExtensionRenderers(): Promise<void> {
    try {
      this.state.rendererHooks = await listCrewCoderExtensionRenderers();
    } catch (error) {
      pushSystemLog(this.state, `Could not load extension renderers: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async loadLiveUiContributions(): Promise<void> {
    try {
      const contributions = await listCrewCoderLiveUiContributions();
      this.state.liveUiContributions = contributions;
    } catch (error) {
      pushSystemLog(this.state, `Could not load live UI contributions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async loadProviders(): Promise<ProviderRecord[]> {
    try {
      const providers = await listCrewCoderProviders();
      if (providers.length) return providers;
    } catch (error) {
      this.state.blocks.push({ type: "error", text: `Could not list providers: ${error instanceof Error ? error.message : String(error)}` });
    }
    return builtinProviderDefaults;
  }

  private async loadSessions(): Promise<unknown[]> {
    try {
      return await listCrewCoderSessions();
    } catch {
      return [];
    }
  }

  private renderPopover(ctx: RenderContext, height: number): string[] {
    if (!this.activePopover || height <= 0) return [];
    const lines = this.activePopover.component.render({ ...ctx, size: { width: ctx.size.width, height } }).slice(0, height);
    while (lines.length < height) lines.push(" ".repeat(ctx.size.width));
    return lines;
  }

  private showCopiedPopup(): void {
    this.showNoticePopup("✓ Copied to clipboard", "success");
  }

  private showAbortPopup(): void {
    this.showNoticePopup("✕ Request aborted", "warning");
  }

  private showNoticePopup(text: string, color: "success" | "warning"): void {
    this.noticePopupText = text;
    this.noticePopupColor = color;
    this.noticePopupUntil = Date.now() + 1400;
  }

  private renderNoticePopup(lines: string[], ctx: RenderContext): string[] {
    if (Date.now() >= this.noticePopupUntil || !this.noticePopupText || lines.length === 0) return lines;
    const content = ` ${this.noticePopupText} `;
    const width = Math.min(ctx.size.width, content.length);
    const left = Math.max(0, ctx.size.width - width - 2);
    const row = 0;
    const color = this.noticePopupColor === "warning" ? ctx.theme.warning : ctx.theme.success;
    const popup = `${bg(ctx.theme.surfaceAlt)}${fg(color)}${bold()}${content.slice(0, width)}${reset()}`;
    const current = stripToWidth(lines[row] ?? "", ctx.size.width);
    lines[row] = current.slice(0, left) + popup + current.slice(left + width);
    return lines;
  }


  private openCommandPopover(query = this.state.input, refreshNow = true): void {
    this.commands.setQuery(query);
    if (this.activePopover?.kind === "commands") return;
    this.commands.setItems(builtinPaletteItems(this.state.integrationProfile));
    this.activePopover = { component: this.commands, height: 11, kind: "commands" };
    if (refreshNow) void this.refreshCommandPaletteItems();
    else {
      if (this.commandPaletteRefreshTimer) clearTimeout(this.commandPaletteRefreshTimer);
      this.commandPaletteRefreshTimer = setTimeout(() => {
        this.commandPaletteRefreshTimer = undefined;
        if (this.activePopover?.kind === "commands") void this.refreshCommandPaletteItems();
      }, 150);
    }
  }

  private async refreshCommandPaletteItems(): Promise<void> {
    const [workerResult, extensionResult] = await Promise.all([this.listWorkers(), this.listPaletteExtensions()]);
    if (this.activePopover?.kind !== "commands") return;
    const workers = Array.isArray(workerResult) ? workerResult : [];
    const extensions = Array.isArray(extensionResult) ? extensionResult : [];
    const dynamic: CommandPaletteItem[] = [
      ...TUI_MODES.map((mode) => ({
        id: `mode:${mode}`, category: "Modes" as const, label: mode,
        description: MODE_DESCRIPTIONS[mode],
        action: { type: "command" as const, command: `/mode ${mode}` }
      })),
      ...workers.map((worker) => ({
        id: `worker:${worker.name}`, category: "Workers" as const, label: worker.name,
        description: worker.ownerName ? `owner: ${worker.ownerName}` : "Saved CrewCoder worker",
        keywords: ["agent", "mode"], action: { type: "command" as const, command: `/worker ${worker.name}` }
      })),
      ...extensions.map((extension) => ({
        id: `extension:${extension.id}`, category: "Extensions" as const, label: extension.name,
        description: `${extension.id}${extension.version ? ` · v${extension.version}` : ""}`, keywords: [extension.id],
        action: { type: "extension" as const, extensionId: extension.id }
      }))
    ];
    this.commands.setItems([...builtinPaletteItems(this.state.integrationProfile), ...dynamic]);
    // Dynamic workers and extensions arrive after the palette opens. Sessions
    // are intentionally loaded only after /sessions or /resume is selected.
    // Repaint immediately so a query that was showing "No matches" updates
    // without requiring an extra keypress.
    this.repaint?.();
  }

  private async listPaletteExtensions(): Promise<Array<{ id: string; name: string; version?: string }>> {
    try {
      const { stdout, exitCode } = await execCrewCoderCommand(["extension", "list"]);
      if (exitCode !== 0) return [];
      return stdout.split("\n").flatMap((line) => {
        const match = line.match(/^(\S+)\s+-\s+(.+?)\s+v([^\s]+)$/);
        return match ? [{ id: match[1]!, name: match[2]!, version: match[3]! }] : [];
      });
    } catch { return []; }
  }

  private openPanelPopover(component: Component, height: number, kind: "panel" | "agents" = "panel"): void {
    this.activePopover = { component, height, kind };
  }

  private openApprovalPopover(approval: Extract<TuiEventBlock, { type: "approval" }>): void {
    if (!approval.id || approval.status !== "pending") return;
    this.activePopover = {
      component: new ApprovalOverlay(approval, (approved) => this.resolveApprovalCommand(approval.id ?? "", approved)),
      height: 16,
      kind: "approval",
      approvalId: approval.id
    };
  }

  private openExtensionUiPopover(request: Extract<TuiEventBlock, { type: "extension_ui" }>): void {
    if (!request.requestId || request.status !== "pending") return;
    this.activePopover = {
      component: new ExtensionUiOverlay(request, (value) => this.resolveUiRequestCommand(request.requestId, value)),
      height: 14,
      kind: "extension_ui",
      requestId: request.requestId
    };
  }

  private openCompactionPreviewOverlay(params: CompactionPreviewParams, context: { mode: "live"; previewId: string } | { mode: "idle"; sessionId: string }): void {
    this.forceConversationView = true;
    this.pendingCompactionPreview = context;
    this.activePopover = {
      component: new CompactionPreviewOverlay(params, (result) => this.resolveCompactionPreview(result)),
      height: 18,
      kind: "compaction_preview",
      ...(context.mode === "live" ? { previewId: context.previewId } : {})
    };
  }

  private cancelCompactionPreview(): void {
    this.resolveCompactionPreview({ approved: false, summary: "" });
  }

  private resolveCompactionPreview(result: { approved: boolean; summary: string }): void {
    const context = this.pendingCompactionPreview;
    this.pendingCompactionPreview = undefined;
    if (this.activePopover?.kind === "compaction_preview") this.closeActivePopover();
    if (!context) return;
    if (context.mode === "live") {
      if (!this.bridge.resolveCompactionPreview(context.previewId, result.approved, result.approved ? result.summary : undefined)) {
        this.state.blocks.push({ type: "error", text: "No active CrewCoder run is waiting for this compaction preview." });
      }
      if (!result.approved) pushSystemLog(this.state, "Compaction preview cancelled.");
      return;
    }
    if (!result.approved) { pushSystemLog(this.state, "Compaction preview cancelled."); return; }
    void this.applyEditedCompaction(context.sessionId, result.summary);
  }

  private async applyEditedCompaction(sessionId: string, summary: string): Promise<void> {
    if (isCrewCoderRemote()) {
      this.state.blocks.push({ type: "error", text: "Applying an edited idle compaction summary is not available in remote SSH mode yet. Live compaction previews and ordinary /compact still work remotely." });
      return;
    }
    const tmpFile = path.join(os.tmpdir(), `crewcoder-compact-${sessionId}-${Date.now()}.md`);
    this.state.running = true;
    const block: Extract<TuiEventBlock, { type: "compaction" }> = {
      type: "compaction",
      status: "running",
      percent: 40,
      message: `Applying edited summary to session ${sessionId}…`
    };
    this.state.blocks.push(block);
    try {
      fsSync.writeFileSync(tmpFile, summary, "utf8");
      const args = ["session", "compact", sessionId, "--summary-file", tmpFile, "--json"];
      const { stderr, exitCode } = await execCrewCoderCommand(args);
      if (exitCode !== 0) {
        block.status = "failed";
        block.percent = 100;
        block.message = stderr.trim() || `Compaction exited with code ${exitCode}.`;
        return;
      }
      block.status = "done";
      block.percent = 100;
      block.message = `Session ${sessionId} compacted with edited summary.`;
    } catch (error) {
      block.status = "failed";
      block.percent = 100;
      block.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.state.running = false;
      try { fsSync.unlinkSync(tmpFile); } catch {}
    }
  }

  private resolveUiRequestCommand(requestId: string, value: string | boolean | null): void {
    if (!requestId) return;
    if (!this.bridge.resolveUiRequest(requestId, value)) {
      this.state.blocks.push({ type: "error", text: "No active CrewCoder run is waiting for this extension prompt." });
    }
    const block = this.findExtensionUiBlock(requestId);
    if (block && block.status === "pending") {
      block.status = value === null ? "cancelled" : "answered";
      if (value !== null) block.answer = typeof value === "boolean" ? (value ? "yes" : "no") : value;
    }
    if (this.activePopover?.kind === "extension_ui" && this.activePopover.requestId === requestId) this.closeActivePopover();
  }

  private closeActivePopover(): void {
    this.modalContentOrigin = undefined;
    if (this.commandPaletteRefreshTimer) clearTimeout(this.commandPaletteRefreshTimer);
    this.commandPaletteRefreshTimer = undefined;
    this.activePopover = undefined;
  }

  private handleCrewCoderEvent(event: Parameters<typeof applyCrewCoderEvent>[1]): void {
    // The run is over once the loop reports completion, even if the child
    // process is still shutting down. Anything typed after this starts a new run.
    if (event.type === "agent_end" || event.type === "agent_error" || event.type === "process_exit" || event.type === "process_error") {
      this.runActive = false;
    }
    const wasAtBottom = this.state.viewportScroll === 0;
    applyCrewCoderEvent(this.state, event);
    if (wasAtBottom) this.state.viewportScroll = 0;
    this.pruneLiveUiBlocks();

    if (event.type === "session_compaction_preview") {
      const previewId = typeof event.previewId === "string" ? event.previewId : undefined;
      const summary = typeof event.summary === "string" ? event.summary : undefined;
      if (previewId && summary !== undefined) {
        this.openCompactionPreviewOverlay({
          title: "Edit compaction summary",
          summary,
          source: typeof event.source === "string" ? event.source : undefined,
          originalMessageCount: typeof event.originalMessageCount === "number" ? event.originalMessageCount : undefined,
          retainedMessageCount: typeof event.retainedMessageCount === "number" ? event.retainedMessageCount : undefined
        }, { mode: "live", previewId });
      }
    }
    if (event.type === "session_compacted") {
      if (this.activePopover?.kind === "compaction_preview") this.closeActivePopover();
      this.pendingCompactionPreview = undefined;
    }
    if (event.type === "approval_required") {
      const approvalId = typeof event.approvalId === "string" ? event.approvalId : undefined;
      const approval = this.findApprovalBlock(approvalId);
      if (approval) this.openApprovalPopover(approval);
    }
    if (event.type === "approval_resolved") {
      const approvalId = typeof event.approvalId === "string" ? event.approvalId : undefined;
      if (this.activePopover?.kind === "approval" && this.activePopover.approvalId === approvalId) this.closeActivePopover();
    }
    if (event.type === "extension_ui_request") {
      const requestId = typeof event.requestId === "string" ? event.requestId : undefined;
      const request = this.findExtensionUiBlock(requestId);
      if (request) this.openExtensionUiPopover(request);
      void this.tryMountLiveUiFromExtensionEvent(event);
    }
    if (event.type === "extension_ui_resolved") {
      const requestId = typeof event.requestId === "string" ? event.requestId : undefined;
      if (this.activePopover?.kind === "extension_ui" && this.activePopover.requestId === requestId) this.closeActivePopover();
      if (requestId) this.disposeLiveUiByRequestId(requestId);
    }
    if (event.type === "tool_execution_end") {
      void this.tryMountLiveUiForToolBlock(event);
    }
    if (event.type === "token_budget_exceeded") {
      const sourceSessionId = typeof event.sessionId === "string" ? event.sessionId : this.state.sessionId;
      const summary = typeof event.handoffSummary === "string" ? event.handoffSummary.trim() : "";
      if (sourceSessionId && summary) this.openBudgetReachedPopover({ sourceSessionId, summary });
    }
  }

  private findApprovalBlock(approvalId: string | undefined): Extract<TuiEventBlock, { type: "approval" }> | undefined {
    for (let i = this.state.blocks.length - 1; i >= 0; i--) {
      const block = this.state.blocks[i];
      if (block?.type === "approval" && block.id === approvalId) return block;
    }
    return undefined;
  }

  private findExtensionUiBlock(requestId: string | undefined): Extract<TuiEventBlock, { type: "extension_ui" }> | undefined {
    for (let i = this.state.blocks.length - 1; i >= 0; i--) {
      const block = this.state.blocks[i];
      if (block?.type === "extension_ui" && block.requestId === requestId) return block;
    }
    return undefined;
  }

  private async tryMountLiveUiFromExtensionEvent(event: Parameters<typeof applyCrewCoderEvent>[1]): Promise<void> {
    const extensionId = typeof event.extensionId === "string" ? event.extensionId : undefined;
    const requestId = typeof event.requestId === "string" ? event.requestId : undefined;
    if (!extensionId || !requestId) return;
    const contributions = this.state.liveUiContributions?.filter((c) => c.extensionId === extensionId && c.allowed) ?? [];
    if (!contributions.length) return;

    const gateContext: TuiLiveUiGateContext = {
      enabled: true,
      trusted: true,
      allowLiveUi: this.state.allowExtensionLiveUi
    };

    const uiKind = typeof event.uiKind === "string" ? event.uiKind as CrewCoderLiveUiKind : undefined;
    const tuiEvent: TuiLiveUiEvent = {
      type: String(event.type),
      ...(requestId ? { requestId } : {}),
      ...(uiKind ? { uiKind } : {}),
      ...(typeof event.title === "string" ? { title: event.title } : {}),
      ...(typeof event.message === "string" ? { message: event.message } : {}),
      ...(event.component ? { component: event.component as TuiLiveUiEvent["component"] } : {}),
      ...(event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
        ? { metadata: event.metadata as TuiLiveUiEvent["metadata"] }
        : {})
    };

    let plan: LiveUiSpawnPlan | undefined;
    let matchedEntry: string | undefined;
    for (const contribution of contributions) {
      if (!contribution.entry) continue;
      // Transcript surfaces are reserved for tool-anchored renderers. Mounting one
      // for a generic extension request would append it to the transcript tail,
      // making it look like persistent chrome directly above the composer.
      if (contribution.surface === "transcript") continue;
      const tuiContribution: TuiLiveUiContribution = {
        id: contribution.id,
        title: contribution.title,
        entry: contribution.entry,
        experimental: contribution.experimental,
        target: { surface: contribution.surface as TuiLiveUiContribution["target"]["surface"], ...(contribution.slot ? { slot: contribution.slot } : {}) },
        permissions: contribution.permissions as TuiLiveUiContribution["permissions"],
        activation: contribution.activation as TuiLiveUiContribution["activation"],
        match: contribution.match as TuiLiveUiContribution["match"]
      };
      if (!matchesTuiLiveUiContribution(tuiContribution, tuiEvent)) continue;
      const candidate = prepareLiveUiSpawn(extensionId, tuiContribution, tuiEvent, gateContext);
      if (candidate.allowed) {
        plan = candidate;
        matchedEntry = contribution.entry;
        break;
      }
    }
    if (!plan || !plan.allowed || !matchedEntry) return;

    const key = `liveui:${requestId}`;
    this.state.blocks.push({
      type: "live_ui",
      key,
      extensionId: plan.props.extensionId,
      contributionId: plan.props.contributionId,
      surface: plan.props.surface,
      status: "loading",
      title: plan.props.surface === "status" ? `${plan.props.extensionId}/${plan.props.contributionId}` : (tuiEvent.title ?? "")
    });
    const size = liveUiSurfaceSize(plan.props.surface, { width: 80, height: 24 });
    this.liveUiController.mount({
      key,
      entryPath: matchedEntry,
      props: plan.props,
      host: plan.host,
      width: size.width,
      height: size.height,
      title: `${plan.props.extensionId}/${plan.props.contributionId}`,
      blockId: requestId
    });
  }

  private async tryMountLiveUiForToolBlock(event: Parameters<typeof applyCrewCoderEvent>[1]): Promise<void> {
    const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (!toolName) return;

    // Find the tool block that was just finalized.
    let toolIndex = -1;
    let toolBlock: Extract<TuiState["blocks"][number], { type: "tool" }> | undefined;
    for (let i = this.state.blocks.length - 1; i >= 0; i--) {
      const block = this.state.blocks[i];
      if (block?.type === "tool" && (toolCallId ? block.id === toolCallId : block.name === toolName) && (block.status === "done" || block.status === "error")) {
        toolIndex = i;
        toolBlock = block;
        break;
      }
    }
    if (!toolBlock || toolIndex === -1) return;

    const gateContext: TuiLiveUiGateContext = {
      enabled: true,
      trusted: true,
      allowLiveUi: this.state.allowExtensionLiveUi
    };

    const metadata = toolBlock.metadata && typeof toolBlock.metadata === "object" && !Array.isArray(toolBlock.metadata)
      ? (toolBlock.metadata as Record<string, unknown>)
      : {};
    const tuiEvent: TuiLiveUiEvent = {
      type: String(event.type),
      toolName,
      ...(toolCallId ? { toolCallId } : {}),
      metadata: {
        ...metadata,
        toolName,
        ...(toolCallId ? { toolCallId } : {}),
        args: toolBlock.args ?? {},
        result: toolBlock.text ?? "",
        isError: toolBlock.status === "error"
      } as TuiLiveUiEvent["metadata"]
    };

    let plan: LiveUiSpawnPlan | undefined;
    let matchedEntry: string | undefined;
    for (const contribution of this.state.liveUiContributions?.filter((c) => c.allowed) ?? []) {
      if (!contribution.entry) continue;
      const surface = contribution.surface as TuiLiveUiContribution["target"]["surface"];
      if (surface !== "transcript") continue;
      const tuiContribution: TuiLiveUiContribution = {
        id: contribution.id,
        title: contribution.title,
        entry: contribution.entry,
        experimental: contribution.experimental,
        target: { surface, ...(contribution.slot ? { slot: contribution.slot } : {}) },
        permissions: contribution.permissions as TuiLiveUiContribution["permissions"],
        activation: contribution.activation as TuiLiveUiContribution["activation"],
        match: contribution.match as TuiLiveUiContribution["match"]
      };
      if (!matchesTuiLiveUiContribution(tuiContribution, tuiEvent)) continue;
      const candidate = prepareLiveUiSpawn(contribution.extensionId, tuiContribution, tuiEvent, gateContext);
      if (candidate.allowed) {
        plan = candidate;
        matchedEntry = contribution.entry;
        break;
      }
    }
    if (!plan || !plan.allowed || !matchedEntry) return;

    const key = `liveui:tool:${toolCallId ?? toolName}`;
    this.state.blocks.splice(toolIndex + 1, 0, {
      type: "live_ui",
      key,
      extensionId: plan.props.extensionId,
      contributionId: plan.props.contributionId,
      surface: plan.props.surface,
      status: "loading",
      title: tuiEvent.title ?? toolName
    });
    const size = liveUiSurfaceSize(plan.props.surface, { width: 80, height: 24 });
    this.liveUiController.mount({
      key,
      entryPath: matchedEntry,
      props: plan.props,
      host: plan.host,
      width: size.width,
      height: size.height,
      title: `${plan.props.extensionId}/${plan.props.contributionId}`,
      blockId: key
    });
  }

  private disposeLiveUiByRequestId(requestId: string): void {
    const key = `liveui:${requestId}`;
    for (let i = this.state.blocks.length - 1; i >= 0; i--) {
      const block = this.state.blocks[i];
      if (block?.type === "live_ui" && block.key === key) {
        this.state.blocks.splice(i, 1);
        break;
      }
    }
    this.liveUiController.disposeByBlock(requestId, "overlay_close");
  }

  /** Tear down every live UI instance owned by an extension when it unloads. */
  unloadLiveUiExtension(extensionId: string): void {
    void this.liveUiController.disposeByExtension(extensionId, "extension_unload");
    this.state.liveUiContributions = this.state.liveUiContributions?.filter((c) => c.extensionId !== extensionId);
  }

  /**
   * Transcript blocks can be dropped when the block buffer is trimmed or the user
   * clears history. Any live UI instance whose block id has vanished should be
   * disposed so its worker does not outlive the UI it was rendering.
   */
  private pruneLiveUiBlocks(): void {
    const liveKeys = new Set(this.state.blocks.filter((b) => b.type === "live_ui").map((b) => (b as { key: string }).key));
    for (const entry of this.liveUiRegistry.list()) {
      if (entry.blockId && !liveKeys.has(entry.blockId)) {
        void this.liveUiController.disposeByBlock(entry.blockId, "scroll_away");
      }
    }
  }

  /**
   * When the focused live UI child returns `handled: false`, fall through to the
   * normal TUI input path without re-forwarding the event to live UI. This keeps
   * global shortcuts and composer navigation working even while a component owns
   * focus for events it does not consume.
   */
  private handleLiveUiUnhandledInput(event: CrewCoderLiveUiInputEvent): void {
    const keyEvent: KeyEvent = {
      name: event.name,
      sequence: event.sequence ?? "",
      ctrl: event.ctrl ?? false,
      meta: event.meta ?? false,
      shift: event.shift ?? false,
      ...(event.mouse ? { mouse: event.mouse } : {})
    };
    this.dispatchInputWithoutLiveUi(keyEvent);
  }

  /**
   * Run the normal input dispatch path but skip live UI forwarding so a bounced
   * unhandled event cannot loop back into the focused host.
   */
  private dispatchInputWithoutLiveUi(event: KeyEvent): void {
    if (this.handleGlobalShortcut(event)) return;
    if (this.handleSidebarResizeInput(event)) return;

    if (this.activePopover) {
      if (event.name === "mouse") return;
      if (event.name === "escape") {
        if (this.activePopover.kind === "extension_ui" && this.activePopover.requestId) {
          this.resolveUiRequestCommand(this.activePopover.requestId, null);
        } else {
          this.closeActivePopover();
        }
        return;
      }
      if (this.activePopover.kind === "commands") {
        if (event.name === "up" || event.name === "down" || event.name === "return") {
          const handled = this.activePopover.component.handleInput?.(event);
          if (!handled && event.name === "return") {
            this.closeActivePopover();
            this.composer.handleInput(event);
            return;
          }
          return;
        }
      } else if (this.activePopover.kind === "mentions") {
        if (event.name === "up" || event.name === "down" || event.name === "return") {
          this.activePopover.component.handleInput?.(event);
          return;
        }
      } else {
        this.activePopover.component.handleInput?.(event);
        return;
      }
    }

    if (event.name === "escape" && this.state.running) {
      this.abortActiveRequest();
      return;
    }

    if (event.name === "mouse") {
      this.handleMouseInput(event);
      return;
    }

    if ((event.name === "up" || event.name === "down") && this.composer.handleVerticalArrow(event.name)) {
      this.syncInputPopovers();
      return;
    }

    const viewportHandled = this.handleViewportInput(event);
    if (viewportHandled) return;

    this.composer.handleInput(event);
    this.syncInputPopovers();
  }

  // Terminals deliver Tab as Ctrl+I (both are byte 0x09), so the agents
  // shortcut is matched on ctrl+"i". Ctrl+P and Ctrl+B arrive by name.
  private handleGlobalShortcut(event: KeyEvent): boolean {
    if (event.ctrl && event.name === "p") { this.toggleCommandPopover(); return true; }
    if (event.ctrl && event.name === "i") { this.toggleAgentsOverlay(); return true; }
    if (event.ctrl && event.name === "b") { this.toggleSidebar(); return true; }
    return false;
  }

  private toggleCommandPopover(): void {
    if (this.activePopover?.kind === "commands") { this.closeActivePopover(); return; }
    this.openCommandPopover("/");
  }

  private toggleAgentsOverlay(): void {
    if (this.activePopover?.kind === "agents") { this.closeActivePopover(); return; }
    void this.openModesOverlay();
  }

  private syncInputPopovers(): void {
    if (this.state.input.startsWith("/")) {
      this.openCommandPopover(this.state.input, false);
      return;
    }
    if (this.activePopover?.kind === "commands") this.closeActivePopover();
    this.syncMentionPopover();
  }

  private syncMentionPopover(): void {
    if (isCrewCoderRemote()) {
      if (this.activePopover?.kind === "mentions") this.closeActivePopover();
      return;
    }
    const mention = currentMentionToken(this.state.input, this.state.inputCursor);
    if (!mention) {
      if (this.activePopover?.kind === "mentions") this.closeActivePopover();
      return;
    }

    const requestId = ++this.mentionRequestId;
    void listPathSuggestions(this.state.cwd, mention.query, 50).then((suggestions) => {
      if (requestId !== this.mentionRequestId) return;
      const latest = currentMentionToken(this.state.input, this.state.inputCursor);
      if (!latest || latest.query !== mention.query) return;
      this.activePopover = {
        kind: "mentions",
        height: 10,
        component: new PickerOverlay("Attach file or folder", suggestions.map((suggestion) => ({
          label: suggestion.path,
          value: suggestion.path,
          description: suggestion.type
        })), (option) => {
          this.replaceMention(latest.start, latest.end, option.value);
          this.closeActivePopover();
        })
      };
    }).catch((error) => {
      this.state.blocks.push({ type: "error", text: `Could not list workspace paths: ${error instanceof Error ? error.message : String(error)}` });
    });
  }

  private replaceMention(start: number, end: number, value: string): void {
    const replacement = `@${value} `;
    this.state.input = this.state.input.slice(0, start) + replacement + this.state.input.slice(end);
    this.state.inputCursor = start + replacement.length;
  }

  private selectPaletteItem(item: CommandPaletteItem): void {
    this.state.input = "";
    this.state.inputCursor = 0;
    this.closeActivePopover();
    if (item.action.type === "command") { this.submit(item.action.command); return; }
    if (item.action.type === "extension") {
      void this.runCliCommand(["extension", "inspect", item.action.extensionId]);
      return;
    }
    const sessionId = item.action.sessionId;
    void this.loadSessions().then((sessions) => {
      const session = (sessions as SessionRecord[]).find((entry) => entry.id === sessionId);
      if (session) this.resumeSelectedSession(session);
      else this.state.blocks.push({ type: "error", text: `Session not found: ${sessionId}` });
    });
  }
}


export function parseGoalStartInput(parts: string[]): GoalStartInput {
  const objective: string[] = [];
  let maxTurns: number | undefined;
  let checkModel: string | undefined;
  let disableCheckModel = false;
  let timeoutMinutes: number | undefined;
  let positionalOnly = false;

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (positionalOnly) { objective.push(part); continue; }
    if (part === "--") { positionalOnly = true; continue; }
    if (part === "--no-check-model") { disableCheckModel = true; continue; }
    const [name, inlineValue] = splitGoalOption(part);
    if (name === "--max-turns" || name === "--check-model" || name === "--timeout-minutes") {
      const value = inlineValue ?? parts[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
      if (name === "--max-turns") maxTurns = parseGoalOptionInteger(value, name, 10_000);
      else if (name === "--timeout-minutes") timeoutMinutes = parseGoalOptionInteger(value, name, 43_200);
      else {
        checkModel = value.trim();
        if (!checkModel) throw new Error("--check-model requires a non-empty model id.");
      }
      continue;
    }
    if (part.startsWith("--")) throw new Error(`Unknown /goal option: ${part}`);
    objective.push(part);
  }

  if (checkModel && disableCheckModel) throw new Error("Use either --check-model or --no-check-model, not both.");
  const text = objective.join(" ").trim();
  if (!text) throw new Error("Usage: /goal [--max-turns N] [--check-model MODEL|--no-check-model] [--timeout-minutes N] <objective>");
  return {
    objective: text,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(checkModel ? { checkModel } : {}),
    ...(disableCheckModel ? { disableCheckModel: true } : {}),
    ...(timeoutMinutes !== undefined ? { timeoutMinutes } : {})
  };
}

export function tokenizeGoalCommand(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const char of input.trim()) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (current) { parts.push(current); current = ""; }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unclosed quote in /goal command.");
  if (current) parts.push(current);
  return parts;
}

function splitGoalOption(part: string): [string, string | undefined] {
  const equals = part.indexOf("=");
  return equals === -1 ? [part, undefined] : [part.slice(0, equals), part.slice(equals + 1)];
}

function parseGoalOptionInteger(value: string, name: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return parsed;
}

const MIN_SIDEBAR_TERMINAL_WIDTH = 60;
const MIN_SIDEBAR_WIDTH = 18;
const MIN_MAIN_WIDTH = 32;
const MAX_SIDEBAR_WIDTH = 60;

function rightSidebarWidth(totalWidth: number, preferredWidth?: number): number {
  if (totalWidth < MIN_SIDEBAR_TERMINAL_WIDTH) return 0;
  const width = preferredWidth ?? Math.min(36, Math.max(20, Math.floor(totalWidth * 0.26)));
  return clampSidebarWidth(width, totalWidth);
}

function clampSidebarWidth(width: number, totalWidth: number): number {
  const maximum = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, totalWidth - MIN_MAIN_WIDTH - 1));
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maximum, width));
}

function renderRightSidebar(lines: string[], sidebarLines: string[], contentWidth: number, ctx: RenderContext): string[] {
  return Array.from({ length: ctx.size.height }, (_, index) => {
    const content = lines[index] ?? "";
    const sidebar = sidebarLines[index] ?? "";
    return `${padRight(content, contentWidth)}${fg(ctx.theme.borderStrong)}│${reset()}${sidebar}`;
  });
}

type CellRectangle = { top: number; left: number; width: number; height: number };

/**
 * Remove graphics placements whose cell rectangle intersects opaque UI chrome.
 * Terminal image protocols render above text cells and do not support clipping,
 * so even a fully painted modal cannot cover an intersecting image.
 */
function suppressImagesUnder(images: RenderedImagePlacement[] | undefined, cover: CellRectangle): void {
  if (!images?.length || cover.width <= 0 || cover.height <= 0) return;
  const coverBottom = cover.top + cover.height;
  const coverRight = cover.left + cover.width;
  for (let index = images.length - 1; index >= 0; index--) {
    const image = images[index]!;
    const imageBottom = image.row + image.placement.rows;
    const imageRight = image.col + image.placement.cols;
    const intersects = image.row < coverBottom
      && imageBottom > cover.top
      && image.col < coverRight
      && imageRight > cover.left;
    if (intersects) images.splice(index, 1);
  }
}

function centerLine(content: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visibleLength(content)) / 2));
  return padRight(" ".repeat(left) + content, width);
}

function indentLine(content: string, left: number, width: number): string {
  return padRight(" ".repeat(Math.max(0, left)) + content, width);
}

function paintBackground(line: string, fill: string): string {
  return `${bg(fill)}${line.replaceAll(reset(), `${reset()}${bg(fill)}`)}${reset()}`;
}

function alignRight(content: string, rightEdge: number, width: number): string {
  const left = Math.max(0, rightEdge - visibleLength(content));
  return padRight(" ".repeat(left) + content, width);
}

function stripToWidth(line: string, width: number): string {
  const plain = stripAnsi(line);
  return plain.length >= width ? plain.slice(0, width) : plain + " ".repeat(width - plain.length);
}

type MentionToken = { start: number; end: number; query: string };

type CrewCoderReloadConfig = {
  integrationProfile?: "standalone" | "crewcode";
  defaultMode?: string;
  defaultProvider?: string;
  defaultModel?: string;
  allowExtensionLiveUi?: boolean;
  checkpointsEnabled?: boolean;
  thinkingEnabled?: boolean;
  goals?: { maxTurns: number; checkModel?: string; timeoutMinutes: number };
};

type CrewCodeProjectDetection = { detected: boolean; markers: string[]; dismissed: boolean; hasProjectProfile: boolean; shouldPrompt: boolean };

type CrewCoderHomeSummary = { exists: boolean; fileCount: number; latest?: string };

type CrewCoderHomeReload = {
  config?: CrewCoderReloadConfig;
  providers: ProviderRecord[];
  sessions: unknown[];
  home: CrewCoderHomeSummary;
};

async function reloadCrewCoderHomeMetadata(loadProviders: () => Promise<ProviderRecord[]>, loadSessions: () => Promise<unknown[]>): Promise<CrewCoderHomeReload> {
  const [config, profile, providers, sessions, home] = await Promise.all([
    readCrewCoderConfig(),
    readEffectiveIntegrationProfile(),
    loadProviders(),
    loadSessions(),
    isCrewCoderRemote() ? Promise.resolve({ exists: false, fileCount: 0 }) : summarizeCrewCoderHomeDir()
  ]);
  return { config: config ? { ...config, integrationProfile: profile } : { integrationProfile: profile }, providers, sessions, home };
}

function keyEventToLiveUiInput(event: KeyEvent): CrewCoderLiveUiInputEvent {
  return {
    name: event.name,
    ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
    ...(event.ctrl === undefined ? {} : { ctrl: event.ctrl }),
    ...(event.meta === undefined ? {} : { meta: event.meta }),
    ...(event.shift === undefined ? {} : { shift: event.shift }),
    ...(event.mouse ? { mouse: event.mouse } : {})
  };
}

async function readCrewCodeProjectDetection(): Promise<CrewCodeProjectDetection> {
  if (!isCrewCoderRemote()) {
      const root = process.cwd();
      const markers: string[] = [];
      try { await fs.access(path.join(root, "crewcode.plugin.json")); markers.push("crewcode.plugin.json"); } catch {}
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
        if (pkg.crewcode && typeof pkg.crewcode === "object") markers.push("package.json#crewcode");
      } catch {}
      let manifest: Record<string, unknown> = {};
      try { manifest = JSON.parse(await fs.readFile(path.join(root, "crewcoder.json"), "utf8")) as Record<string, unknown>; } catch {}
      const dismissed = manifest.crewcodeProfilePromptDismissed === true;
      const hasProjectProfile = manifest.integrationProfile === "standalone" || manifest.integrationProfile === "crewcode";
      return { detected: markers.length > 0, markers, dismissed, hasProjectProfile, shouldPrompt: markers.length > 0 && !dismissed && !hasProjectProfile };
    }
    try {
      const result = await execCrewCoderCommand(["profile", "detect", "--json"]);
      if (result.exitCode !== 0) throw new Error(result.stderr);
      const raw = JSON.parse(result.stdout) as Partial<CrewCodeProjectDetection>;
      return {
        detected: raw.detected === true,
        markers: Array.isArray(raw.markers) ? raw.markers.filter((item): item is string => typeof item === "string") : [],
        dismissed: raw.dismissed === true,
        hasProjectProfile: raw.hasProjectProfile === true,
        shouldPrompt: raw.shouldPrompt === true
      };
    } catch {
      return { detected: false, markers: [], dismissed: false, hasProjectProfile: false, shouldPrompt: false };
    }
}

async function readEffectiveIntegrationProfile(): Promise<"standalone" | "crewcode"> {
  if (!isCrewCoderRemote()) {
      try {
        const project = JSON.parse(await fs.readFile(path.join(process.cwd(), "crewcoder.json"), "utf8")) as Record<string, unknown>;
        if (project.integrationProfile === "crewcode" || project.integrationProfile === "standalone") return project.integrationProfile;
      } catch {
        // No project override; fall through to the user preference.
      }
      try {
        const user = JSON.parse(await fs.readFile(path.join(crewcoderHomeRoot(), "config.json"), "utf8")) as Record<string, unknown>;
        return user.integrationProfile === "crewcode" ? "crewcode" : "standalone";
      } catch {
        return "standalone";
      }
    }
    try {
      const result = await execCrewCoderCommand(["profile", "show"]);
      return result.exitCode === 0 && result.stdout.trim() === "crewcode" ? "crewcode" : "standalone";
    } catch {
      return "standalone";
    }
}

async function readCrewCoderConfig(): Promise<CrewCoderReloadConfig | undefined> {
  const configPath = path.join(crewcoderHomeRoot(), "config.json");
  try {
    const raw = isCrewCoderRemote()
      ? JSON.parse((await execCrewCoderCommand(["config", "show"])).stdout || "{}") as Record<string, unknown>
      : JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    const goals = raw.goals && typeof raw.goals === "object" && !Array.isArray(raw.goals) ? raw.goals as Record<string, unknown> : undefined;
    return {
      defaultMode: typeof raw.defaultMode === "string" ? raw.defaultMode : undefined,
      defaultProvider: typeof raw.defaultProvider === "string" && raw.defaultProvider.trim() ? raw.defaultProvider.trim() : undefined,
      defaultModel: typeof raw.defaultModel === "string" && raw.defaultModel.trim() ? raw.defaultModel.trim() : undefined,
      allowExtensionLiveUi: raw.allowExtensionLiveUi === true ? true : undefined,
      checkpointsEnabled: raw.checkpointsEnabled !== false,
      thinkingEnabled: raw.thinkingEnabled !== false,
      goals: goals ? {
        maxTurns: normalizedGoalConfigInteger(goals.maxTurns, 200, 10_000),
        timeoutMinutes: normalizedGoalConfigInteger(goals.timeoutMinutes, 480, 43_200),
        ...(typeof goals.checkModel === "string" && goals.checkModel.trim() ? { checkModel: goals.checkModel.trim() } : {})
      } : undefined
    };
  } catch {
    return undefined;
  }
}

function normalizedGoalConfigInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(Math.max(value, 1), maximum)
    : fallback;
}

async function summarizeCrewCoderHomeDir(): Promise<CrewCoderHomeSummary> {
  const root = crewcoderHomeRoot();
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return { exists: false, fileCount: 0 };
  } catch {
    return { exists: false, fileCount: 0 };
  }

  let fileCount = 0;
  let newest = 0;
  const visit = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      const stat = await fs.stat(fullPath);
      newest = Math.max(newest, stat.mtimeMs);
    }
  };

  await visit(root);
  return {
    exists: true,
    fileCount,
    latest: newest ? new Date(newest).toLocaleString() : undefined
  };
}

function crewcoderHomeRoot(): string {
  if (process.env.CREWCODER_HOME?.trim()) return path.resolve(process.env.CREWCODER_HOME);
  return path.join(process.env.HOME || os.homedir(), ".crewcoder");
}

function liveUiSurfaceSize(surface: string, screen: { width: number; height: number }): { width: number; height: number } {
  if (surface === "modal") {
    const width = Math.min(Math.max(48, Math.floor(screen.width * 0.66)), screen.width - 4);
    const height = Math.max(6, Math.floor(screen.height * 0.55));
    return { width, height };
  }
  if (surface === "status") {
    // Status live UI renders in the status bar; keep it compact.
    return { width: Math.max(20, Math.floor(screen.width * 0.3)), height: 2 };
  }
  // transcript and fallback render inline in the main viewport.
  return { width: screen.width, height: Math.max(4, screen.height - 6) };
}

function currentMentionToken(input: string, cursor: number): MentionToken | undefined {
  const safeCursor = Math.max(0, Math.min(input.length, cursor));
  const before = input.slice(0, safeCursor);
  const tokenStart = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t")) + 1;
  if (input[tokenStart] !== "@") return undefined;
  const tokenEndMatch = input.slice(safeCursor).match(/[\s]/);
  const end = tokenEndMatch?.index === undefined ? input.length : safeCursor + tokenEndMatch.index;
  const token = input.slice(tokenStart, end);
  if (!/^@[A-Za-z0-9._/\\-]*$/.test(token)) return undefined;
  return { start: tokenStart, end, query: token.slice(1) };
}

function extractHostname(urlStr: string): string | undefined {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return undefined;
  }
}

export const builtinProviderDefaults: ProviderRecord[] = [
  {
    id: "codex",
    title: "OpenAI Codex",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
    defaultModel: "gpt-5.6-luna",
    description: "- OAuth ChatGPT subscription. Run: crewcoder login codex."
  },
  {
    id: "opencode",
    title: "OpenCode Zen",
    models: ["minimax-2.5", "minimax-m2.5", "qwen3-coder", "sonnet", "opus"],
    defaultModel: "minimax-2.5",
    description: "- OpenCode Zen. Set OPENCODE_API_KEY."
  },
  {
    id: "opencode-go",
    title: "OpenCode Zen Go",
    models: ["minimax-2.5", "minimax-m2.5", "qwen3-coder", "sonnet", "opus"],
    defaultModel: "minimax-2.5",
    description: "- OpenCode Go. Set OPENCODE_API_KEY."
  }
];

export function resolveProviderRecord(providerId: string, provider?: ProviderRecord): ProviderRecord {
  const fallback = builtinProviderDefaults.find((item) => item.id === providerId);
  if (!provider || provider.models.length === 0) {
    return fallback ?? { id: providerId, title: providerId, models: [], defaultModel: undefined };
  }
  return provider;
}

/**
 * Parses `/set-budget` input. Mirrors `parseTokenBudget` in the agent package
 * (`core/token-budget.ts`) so the TUI and `--budget` accept the same shorthand.
 * Returns undefined for anything invalid; the caller reports usage.
 */
export function parseBudgetInput(value: string): number | undefined {
  const normalized = value.trim().toLowerCase().replaceAll("_", "").replaceAll(",", "");
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(normalized);
  if (!match) return undefined;
  const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
  const tokens = Math.floor(Number(match[1]) * multiplier);
  if (!Number.isSafeInteger(tokens) || tokens < 1) return undefined;
  return tokens;
}

export function formatBudgetTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}m`;
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}k`;
  return String(tokens);
}

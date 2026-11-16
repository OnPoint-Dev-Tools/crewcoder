import type {
  CrewCoderEventHandler,
  CrewCoderProcessOptions,
  CrewCoderResumeOptions
} from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
import type { CrewCoderJsonEvent } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/event-parser";
import { applyCrewCoderEvent } from "@onpoint-dev-tools/crewcoder-tui-core/state/event-reducer";
import { createInitialState, type TuiEventBlock, type TuiState } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";

/** The subset of `CrewCoderProcessBridge` the OpenTUI shell drives. */
export type SessionBridge = {
  readonly running: boolean;
  run(options: CrewCoderProcessOptions, onEvent: CrewCoderEventHandler): () => void;
  resume(options: CrewCoderResumeOptions, onEvent: CrewCoderEventHandler): () => void;
  followUp(message: string): boolean;
  resolveApproval(approvalId: string, approved: boolean, reason?: string): boolean;
  stop(): void;
};

type PendingApproval = Extract<TuiEventBlock, { type: "approval" }>;

/**
 * Owns the shared TUI state and the agent bridge for one terminal session.
 * React subscribes through `subscribe`/`getVersion`; the reducer mutates
 * `state` in place, so every change bumps `version` to trigger a render.
 */
export class SessionController {
  readonly state: TuiState;
  private readonly bridge: SessionBridge;
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(bridge: SessionBridge, state: TuiState = createInitialState()) {
    this.bridge = bridge;
    this.state = state;
    // The legacy help tip refers to slash commands this preview does not ship yet.
    this.state.blocks = [];
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** Start, resume, or queue a follow-up for the active run. */
  submit(input: string): void {
    const text = input.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      this.runCommand(text);
      this.notify();
      return;
    }
    if (this.bridge.running) {
      if (this.bridge.followUp(text)) {
        this.state.blocks.push({ type: "user", text, background: ["Queued follow-up for the running turn."] });
      } else {
        this.state.blocks.push({ type: "error", text: "Could not queue follow-up for the active run." });
      }
      this.notify();
      return;
    }
    this.startRun(text);
  }

  /** Resolve the most recent pending approval over the live control channel. */
  resolvePendingApproval(approved: boolean): boolean {
    const pending = this.pendingApproval();
    if (!pending?.id || !this.bridge.running) return false;
    const reason = approved ? "Approved from OpenTUI control channel." : "Denied from OpenTUI control channel.";
    const resolved = this.bridge.resolveApproval(pending.id, approved, reason);
    if (!resolved) this.state.blocks.push({ type: "error", text: `Could not ${approved ? "approve" : "deny"} ${pending.id}.` });
    this.notify();
    return resolved;
  }

  pendingApproval(): PendingApproval | undefined {
    for (let index = this.state.blocks.length - 1; index >= 0; index--) {
      const block = this.state.blocks[index];
      if (block?.type === "approval" && block.status === "pending") return block;
    }
    return undefined;
  }

  /** Abort the active run. Returns false when nothing was running. */
  abort(): boolean {
    if (!this.bridge.running && !this.state.running) return false;
    this.bridge.stop();
    this.state.running = false;
    this.state.blocks.push({ type: "system", text: "Request aborted." });
    this.notify();
    return true;
  }

  dispose(): void {
    this.bridge.stop();
    this.listeners.clear();
  }

  private startRun(prompt: string): void {
    this.state.blocks.push({ type: "user", text: prompt });
    this.state.running = true;
    const onEvent = (event: CrewCoderJsonEvent): void => {
      applyCrewCoderEvent(this.state, event);
      this.notify();
    };
    const shared = {
      prompt,
      provider: this.state.provider,
      mode: this.state.mode,
      worker: this.state.worker,
      model: this.state.model,
      systemPrompt: this.state.systemPrompt,
      effort: this.state.effort,
      cwd: this.state.cwd,
      approval: this.state.fullAccess ? "full-access" as const : "review" as const,
      budget: this.state.tokenBudget,
      externalDirectories: this.state.externalDirectories
    };
    this.notify();
    if (this.state.sessionId && this.state.sessionId !== "new") {
      this.bridge.resume({ ...shared, sessionId: this.state.sessionId }, onEvent);
      return;
    }
    this.bridge.run(shared, onEvent);
  }

  private runCommand(command: string): void {
    const name = command.split(/\s+/, 1)[0];
    if (name === "/new") {
      this.bridge.stop();
      this.state.sessionId = "new";
      this.state.blocks = [];
      this.state.running = false;
      this.state.changedFiles = [];
      this.state.usage = { turns: 0 };
      this.state.externalDirectories = [];
      this.state.tokenBudget = undefined;
      this.state.fullAccess = false;
      return;
    }
    if (name === "/stop") {
      if (!this.abort()) this.state.blocks.push({ type: "system", text: "Nothing is running." });
      return;
    }
    this.state.blocks.push({
      type: "error",
      text: `${name} is not available in the OpenTUI preview yet. Use the legacy UI (crewcoder-tui) or the agent CLI for it.`
    });
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

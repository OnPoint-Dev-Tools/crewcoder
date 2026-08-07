import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../components/App.js";
import { createInitialState } from "../state/tui-store.js";
import { parseInputEvents } from "../tui/input.js";
import { stripAnsi } from "../tui/ansi.js";
import { crewCoderTheme } from "../theme/theme.js";

/**
 * Polls until `condition` holds.
 *
 * Several of these tests drive work that shells out to a real `CREWCODER_BIN`
 * subprocess. A fixed sleep races process spawn: it passes on an idle machine
 * and fails under load, which is not a signal about the code under test. Poll
 * for the state the test actually depends on instead.
 */
async function waitFor(condition: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

describe("App input", () => {
  const originalHome = process.env.HOME;
  const originalCrewCoderHome = process.env.CREWCODER_HOME;
  const originalCrewCoderBin = process.env.CREWCODER_BIN;
  const originalCrewCoderTuiSystemLogs = process.env.CREWCODER_TUI_SYSTEM_LOGS;
  const originalCrewCoderTasksEnabled = process.env.CREWCODER_TASKS_ENABLED;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCrewCoderHome === undefined) delete process.env.CREWCODER_HOME;
    else process.env.CREWCODER_HOME = originalCrewCoderHome;
    if (originalCrewCoderBin === undefined) delete process.env.CREWCODER_BIN;
    else process.env.CREWCODER_BIN = originalCrewCoderBin;
    if (originalCrewCoderTuiSystemLogs === undefined) delete process.env.CREWCODER_TUI_SYSTEM_LOGS;
    else process.env.CREWCODER_TUI_SYSTEM_LOGS = originalCrewCoderTuiSystemLogs;
    if (originalCrewCoderTasksEnabled === undefined) delete process.env.CREWCODER_TASKS_ENABLED;
    else process.env.CREWCODER_TASKS_ENABLED = originalCrewCoderTasksEnabled;
    delete process.env.CREWCODER_TEST_ARGS_FILE;
  });

  it("inserts @ file and folder mentions from the popover", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-tui-paths-"));
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "src", "App.ts"), "export const app = true;\n", "utf8");
    const state = createInitialState();
    state.cwd = cwd;
    state.input = "see @sr";
    state.inputCursor = state.input.length;
    const app = new App(state);

    app.handleInput({ name: "right", sequence: "", ctrl: false, meta: false, shift: false });
    await waitFor(
      () => (app as unknown as { activePopover?: { kind?: string } }).activePopover?.kind === "mentions",
      "the @ mention popover to load path suggestions"
    );
    app.handleInput({ name: "return", sequence: "\r", ctrl: false, meta: false, shift: false });

    expect(state.input).toBe("see @src/ ");
  });

  it("aborts a running request with escape", () => {
    const state = createInitialState();
    state.running = true;
    const app = new App(state);
    let stopped = false;
    (app as unknown as { bridge: { stop: () => void } }).bridge.stop = () => { stopped = true; };

    const handled = app.handleInput({ name: "escape", sequence: "\u001b", ctrl: false, meta: false, shift: false });

    expect(handled).toBe(true);
    expect(stopped).toBe(true);
    expect(state.running).toBe(false);
    expect(state.blocks.some((block) => block.type === "system" && block.text === "Aborted active CrewCoder request.")).toBe(false);
    expect(app.render({ theme: crewCoderTheme, size: { width: 80, height: 24 } }).map(stripAnsi).join("\n")).toContain("✕ Request aborted");
  });

  it("offers staying in the exhausted session when the token budget is reached", () => {
    const state = createInitialState();
    state.sessionId = "session_old";
    const app = new App(state);
    (app as unknown as { handleCrewCoderEvent(event: Record<string, unknown>): void }).handleCrewCoderEvent({
      type: "token_budget_exceeded",
      sessionId: "session_old",
      limit: 100,
      used: 105,
      percent: 105,
      handoffSummary: "- user: build feature"
    });
    expect(app.render({ theme: crewCoderTheme, size: { width: 100, height: 30 } }).map(stripAnsi).join("\n")).toContain("Token budget reached");
    app.handleInput({ name: "return", sequence: "\r", ctrl: false, meta: false, shift: false });
    expect(state.sessionId).toBe("session_old");
  });

  it("starts a summary-only child session with parent linkage", () => {
    const state = createInitialState();
    state.sessionId = "session_old";
    state.provider = "codex";
    state.model = "gpt-test";
    const app = new App(state);
    let launched: Record<string, unknown> | undefined;
    (app as unknown as { bridge: { stop(): void; run(options: Record<string, unknown>, onEvent: () => void): void } }).bridge = {
      stop() {},
      run(options) { launched = options; }
    };
    (app as unknown as { launchBudgetHandoff(handoff: { sourceSessionId: string; summary: string }): void }).launchBudgetHandoff({ sourceSessionId: "session_old", summary: "- changed src/app.ts" });
    expect(launched).toMatchObject({ provider: "codex", model: "gpt-test", parentSessionId: "session_old" });
    expect(String(launched?.prompt)).toContain("- changed src/app.ts");
    expect(String(launched?.prompt)).not.toContain("original transcript content");
    expect(state.sessionId).toBe("new");
  });

  it("queues follow-up messages for an active run", () => {
    const state = createInitialState();
    const app = new App(state);
    let queued = "";
    (app as unknown as { bridge: { running: boolean; followUp: (message: string) => boolean } }).bridge = {
      running: true,
      followUp: (message: string) => { queued = message; return true; }
    };

    for (const event of parseInputEvents("/follow-up add edge-case tests\r")) {
      app.handleInput(event);
    }

    expect(queued).toBe("add edge-case tests");
    expect(state.blocks.at(-1)).toMatchObject({ type: "user", text: "add edge-case tests" });
  });

  it("starts a new run for a reply sent after the turn finished, even while the child lingers", () => {
    const state = createInitialState();
    const app = new App(state);
    let queued = "";
    let started = 0;
    // `running: true` models a backend process that has finished its turn but
    // has not exited yet. The reply must not become a follow-up.
    (app as unknown as { bridge: { running: boolean; followUp: (message: string) => boolean; run: () => void; resume: () => void } }).bridge = {
      running: true,
      followUp: (message: string) => { queued = message; return true; },
      run: () => { started++; },
      resume: () => { started++; }
    };

    for (const event of parseInputEvents("start the work\r")) app.handleInput(event);
    expect(started).toBe(1);

    (app as unknown as { handleCrewCoderEvent: (event: unknown) => void }).handleCrewCoderEvent({ type: "agent_end", sessionId: "session_test", messages: [] });
    for (const event of parseInputEvents("reply after the answer\r")) app.handleInput(event);

    expect(queued).toBe("");
    expect(started).toBe(2);
    expect(state.blocks.at(-1)).toMatchObject({ type: "user", text: "reply after the answer" });
  });

  it("automatically queues plain composer messages while a run is active", () => {
    const state = createInitialState();
    const app = new App(state);
    let queued = "";
    let startedAnotherRun = false;
    (app as unknown as { bridge: { running: boolean; followUp: (message: string) => boolean; run: () => void } }).bridge = {
      running: true,
      followUp: (message: string) => { queued = message; return true; },
      run: () => { startedAnotherRun = true; }
    };
    (app as unknown as { runActive: boolean }).runActive = true;

    for (const event of parseInputEvents("also cover the cancellation path\r")) {
      app.handleInput(event);
    }

    expect(queued).toBe("also cover the cancellation path");
    expect(startedAnotherRun).toBe(false);
    expect(state.blocks.at(-1)).toMatchObject({
      type: "user",
      text: "also cover the cancellation path",
      background: ["Queued follow-up for the running turn."]
    });
  });

  it("attaches an external directory and passes it to new runs", async () => {
    const state = createInitialState();
    const app = new App(state);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-tui-external-"));
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-bin-external-")), "crewcoder");
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ path: external })}'\n`, "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;
    let launched: Record<string, unknown> | undefined;
    (app as unknown as { bridge: { running: boolean; run(options: Record<string, unknown>, onEvent: () => void): void } }).bridge = {
      running: false,
      run(options) { launched = options; }
    };

    for (const event of parseInputEvents(`/add-dir ${external}\r`)) app.handleInput(event);
    await waitFor(() => state.externalDirectories.includes(external), "external directory to attach");
    for (const event of parseInputEvents("inspect shared files\r")) app.handleInput(event);

    expect(launched).toMatchObject({ externalDirectories: [external] });
  });

  it("toggles full-access mode and passes it to new runs", () => {
    const state = createInitialState();
    const app = new App(state);
    let approval: string | undefined;
    (app as unknown as { bridge: { run: (options: { approval?: string }, onEvent: () => void) => void } }).bridge = {
      run: (options: { approval?: string }) => { approval = options.approval; }
    };

    for (const event of parseInputEvents("/full-access on\rdo the risky thing\r")) {
      app.handleInput(event);
    }

    expect(state.fullAccess).toBe(true);
    expect(approval).toBe("full-access");
    expect(state.blocks.some((block) => block.type === "system" && block.text.includes("Full access enabled"))).toBe(true);
  });

  it("isolates file-changes display state between TUI instances", () => {
    const firstState = createInitialState();
    const secondState = createInitialState();
    firstState.changedFiles = ["src/first.ts"];
    secondState.changedFiles = ["src/second.ts"];
    // Force conversation layout so the status bar is visible (the empty-session
    // home screen intentionally omits it).
    firstState.blocks = [{ type: "user", text: "first" }];
    secondState.blocks = [{ type: "user", text: "second" }];
    const firstApp = new App(firstState);
    const secondApp = new App(secondState);

    for (const event of parseInputEvents("/file-changes off\r")) firstApp.handleInput(event);

    expect(firstState.showFileChanges).toBe(false);
    expect(secondState.showFileChanges).toBe(true);
    expect(firstState.changedFiles).toEqual(["src/first.ts"]);
    expect(secondState.changedFiles).toEqual(["src/second.ts"]);
    for (const event of parseInputEvents("/sidebar on\r")) secondApp.handleInput(event);
    const secondRendered = secondApp.render({ theme: crewCoderTheme, size: { width: 100, height: 30 } }).map(stripAnsi).join("\n");
    expect(secondRendered).toContain("MODIFIED FILES 1");
    expect(secondRendered).toContain("src/second.ts");
  });

  it("toggles the file-changes display without discarding tracked files", () => {
    const state = createInitialState();
    state.changedFiles = ["src/kept.ts"];
    const app = new App(state);

    for (const event of parseInputEvents("/file-changes off\r")) app.handleInput(event);
    expect(state.showFileChanges).toBe(false);
    expect(state.changedFiles).toEqual(["src/kept.ts"]);

    for (const event of parseInputEvents("/file-changes\r")) app.handleInput(event);
    expect(state.showFileChanges).toBe(true);
    expect(state.changedFiles).toEqual(["src/kept.ts"]);
  });

  it("keeps /task on|off local to the current TUI process", () => {
    delete process.env.CREWCODER_TASKS_ENABLED;
    const state = createInitialState();
    const app = new App(state);
    let launchedBackendCommand = false;
    (app as unknown as { runCliCommand: () => Promise<void> }).runCliCommand = async () => { launchedBackendCommand = true; };

    for (const event of parseInputEvents("/task on\r")) app.handleInput(event);

    expect(process.env.CREWCODER_TASKS_ENABLED).toBe("true");
    expect(launchedBackendCommand).toBe(false);
    expect(state.blocks.at(-1)).toMatchObject({ type: "system", text: expect.stringContaining("this CrewCoder instance only") });

    for (const event of parseInputEvents("/task off\r")) app.handleInput(event);
    expect(process.env.CREWCODER_TASKS_ENABLED).toBe("false");
  });

  it("routes project memory toggles to the backend", async () => {
    const state = createInitialState();
    const app = new App(state);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-memory-toggle-"));
    const argsFile = path.join(dir, "args.txt");
    const bin = path.join(dir, "crewcoder");
    fs.writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s' "$*" > ${JSON.stringify(argsFile)}\nprintf 'Project memory disabled. Existing facts were preserved.\\n'\n`, "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;

    for (const event of parseInputEvents("/memory off\r")) app.handleInput(event);
    await waitFor(() => fs.existsSync(argsFile), "the memory toggle command to launch");

    expect(fs.readFileSync(argsFile, "utf8")).toBe("memory off");
  });

  it("routes a full project fact through /remember", async () => {
    const state = createInitialState();
    const app = new App(state);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-remember-"));
    const argsFile = path.join(dir, "args.txt");
    const bin = path.join(dir, "crewcoder");
    fs.writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`, "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;

    for (const event of parseInputEvents(`/remember I don't like using the library "dodo"\r`)) app.handleInput(event);
    await waitFor(() => fs.existsSync(argsFile), "the remember command to launch");

    expect(fs.readFileSync(argsFile, "utf8").split("\n").filter(Boolean)).toEqual([
      "remember",
      `I don't like using the library "dodo"`
    ]);
  });

  it("keeps the file-changes display preference across new sessions", () => {
    const state = createInitialState();
    const app = new App(state);

    for (const event of parseInputEvents("/file-changes off\r/new\r")) app.handleInput(event);

    expect(state.showFileChanges).toBe(false);
    expect(state.changedFiles).toEqual([]);
  });

  it("reports file-changes display status and rejects invalid values", () => {
    const state = createInitialState();
    const app = new App(state);

    for (const event of parseInputEvents("/file-changes status\r")) app.handleInput(event);
    expect(state.blocks.at(-1)).toMatchObject({ type: "system", text: expect.stringContaining("display is on") });

    for (const event of parseInputEvents("/file-changes maybe\r")) app.handleInput(event);
    expect(state.blocks.at(-1)).toMatchObject({ type: "error", text: "Usage: /file-changes on|off|status" });
  });

  it("disables full-access mode", () => {
    const state = createInitialState();
    state.fullAccess = true;
    const app = new App(state);

    for (const event of parseInputEvents("/full-access off\r")) {
      app.handleInput(event);
    }

    expect(state.fullAccess).toBe(false);
    expect(state.blocks.at(-1)).toMatchObject({ type: "system", text: "Full access disabled. Future mutating and dangerous tool calls will require approval." });
  });

  it("approves the latest pending approval through the control channel", () => {
    const state = createInitialState();
    state.blocks.push({
      type: "approval",
      id: "approval_call_1",
      toolCallId: "call_1",
      toolName: "write",
      risk: "review",
      text: "write may modify project files.",
      status: "pending"
    });
    const app = new App(state);
    let resolved: { approvalId: string; approved: boolean; reason?: string } | undefined;
    (app as unknown as { bridge: { running: boolean; resolveApproval: (approvalId: string, approved: boolean, reason?: string) => boolean } }).bridge = {
      running: true,
      resolveApproval: (approvalId: string, approved: boolean, reason?: string) => {
        resolved = { approvalId, approved, reason };
        return true;
      }
    };

    for (const event of parseInputEvents("/approve\r")) {
      app.handleInput(event);
    }

    expect(resolved).toEqual({
      approvalId: "approval_call_1",
      approved: true,
      reason: "Approved from TUI control channel."
    });
  });

  it("opens an approval popup and approves with y", () => {
    const state = createInitialState();
    state.blocks = [];
    const app = new App(state);
    let resolved: { approvalId: string; approved: boolean; reason?: string } | undefined;
    (app as unknown as { bridge: { running: boolean; resolveApproval: (approvalId: string, approved: boolean, reason?: string) => boolean } }).bridge = {
      running: true,
      resolveApproval: (approvalId: string, approved: boolean, reason?: string) => {
        resolved = { approvalId, approved, reason };
        return true;
      }
    };

    (app as unknown as { handleCrewCoderEvent: (event: any) => void }).handleCrewCoderEvent({
      type: "approval_required",
      approvalId: "approval_call_1",
      toolCallId: "call_1",
      toolName: "write",
      risk: "review",
      reason: "write may modify project files.",
      args: { path: "README.md" }
    });

    expect((app as unknown as { activePopover?: { kind?: string; approvalId?: string } }).activePopover).toMatchObject({
      kind: "approval",
      approvalId: "approval_call_1"
    });
    expect(app.render({ theme: crewCoderTheme, size: { width: 90, height: 28 } }).map(stripAnsi).join("\n")).toContain("Approval required");

    app.handleInput({ name: "y", sequence: "y", ctrl: false, meta: false, shift: false });

    expect(resolved).toEqual({
      approvalId: "approval_call_1",
      approved: true,
      reason: "Approved from TUI control channel."
    });
    expect((app as unknown as { activePopover?: unknown }).activePopover).toBeUndefined();
  });

  it("refuses /compact while a model run is active", () => {
    const state = createInitialState();
    const app = new App(state);
    let wrote = false;
    (app as unknown as { bridge: { running: boolean; writeLine: () => void } }).bridge = {
      running: true,
      writeLine: () => { wrote = true; }
    };

    for (const event of parseInputEvents("/compact\r")) {
      app.handleInput(event);
    }

    expect(wrote).toBe(false);
    expect(state.blocks.at(-1)).toMatchObject({
      type: "compaction",
      status: "skipped",
      message: "Cannot compact while the model is running. Wait for the current response to finish, then run /compact."
    });
  });

  it("renders /review-summary as a dedicated block", async () => {
    const state = createInitialState();
    const app = new App(state);
    const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-review-args-")), "args.txt");
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-bin-review-")), "crewcoder");
    fs.writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s' "$*" > ${JSON.stringify(argsFile)}\nprintf '%s\\n' '{"branch":"main","clean":false,"changedFiles":["README.md"],"issueReferences":[{"id":"7","source":"branch","text":"GH-7"}]}'\n`, "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;

    for (const event of parseInputEvents("/review-summary\r")) {
      app.handleInput(event);
    }
    await waitFor(() => state.blocks.at(-1)?.type === "review_summary", "the review summary block to render");

    expect(fs.readFileSync(argsFile, "utf8")).toBe("git review-summary --json");
    expect(state.blocks.at(-1)).toEqual({
      type: "review_summary",
      summary: {
        branch: "main",
        clean: false,
        changedFiles: ["README.md"],
        issueReferences: [{ id: "7", source: "branch", text: "GH-7", url: undefined }]
      }
    });
  });

  it("opens a checkpoint picker for bare /rewind with multiple checkpoints", () => {
    const state = createInitialState();
    state.sessionId = "session_rewind";
    state.checkpoints.push({ id: "checkpoint_old", sessionId: "session_rewind", reason: "old", fileCount: 1, totalBytes: 1, truncated: false });
    state.checkpoints.push({ id: "checkpoint_new", sessionId: "session_rewind", reason: "new", fileCount: 2, totalBytes: 2, truncated: false });
    const app = new App(state);

    for (const event of parseInputEvents("/rewind\r")) {
      app.handleInput(event);
    }

    expect((app as unknown as { activePopover?: { kind?: string } }).activePopover).toMatchObject({ kind: "panel" });
  });

  it("asks for confirmation when rewind preview includes deletes", async () => {
    const state = createInitialState();
    state.sessionId = "session_rewind";
    state.checkpoints.push({ id: "checkpoint_new", sessionId: "session_rewind", reason: "new", fileCount: 2, totalBytes: 2, truncated: false });
    const app = new App(state);
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-bin-rewind-confirm-")), "crewcoder");
    fs.writeFileSync(bin, `#!/usr/bin/env bash\nif [[ "$*" == *"rewind-preview"* ]]; then\n  printf '%s\\n' '{"restoreFiles":["README.md"],"deleteFiles":["new.txt"],"changedFiles":["README.md"],"missingFiles":[],"diffs":[{"path":"README.md","lines":["-1: before","+1: after"],"truncated":false}]}'\nelse\n  printf '%s\\n' '{"restoredFiles":1,"deletedFiles":1}'\nfi\n`, "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;

    for (const event of parseInputEvents("/rewind latest\r")) {
      app.handleInput(event);
    }
    await waitFor(
      () => state.blocks.some((block) => block.type === "system" && block.text.includes("delete 1 files")),
      "the rewind preview confirmation to render"
    );

    expect((app as unknown as { activePopover?: { kind?: string } }).activePopover).toMatchObject({ kind: "panel" });
    expect(state.blocks.some((block) => block.type === "system" && block.text.includes("delete 1 files"))).toBe(true);
    expect(state.blocks.some((block) => block.type === "checkpoint_diff" && block.lines.includes("-1: before"))).toBe(true);
  });

  it("runs /rewind latest against the newest checkpoint", async () => {
    process.env.CREWCODER_TUI_SYSTEM_LOGS = "1";
    const state = createInitialState();
    state.sessionId = "session_rewind";
    state.checkpoints.push({ id: "checkpoint_old", sessionId: "session_rewind", reason: "old", fileCount: 1, totalBytes: 1, truncated: false });
    state.checkpoints.push({ id: "checkpoint_new", sessionId: "session_rewind", reason: "new", fileCount: 2, totalBytes: 2, truncated: false });
    const app = new App(state);
    const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-rewind-args-")), "args.json");
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-bin-rewind-")), "crewcoder");
    fs.writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s' "$*" > ${JSON.stringify(argsFile)}\nprintf '%s\\n' '{"restoredFiles":2,"deletedFiles":1}'\n`, "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;

    for (const event of parseInputEvents("/rewind latest\r")) {
      app.handleInput(event);
    }
    // /rewind runs two sequential subprocesses (rewind-preview, then rewind) and
    // the stub overwrites argsFile each time. Wait on the final rendered block:
    // the args file is written inside the child process, so it lands *before*
    // the App has handled the result.
    await waitFor(
      () => state.blocks.some((block) => block.type === "system" && block.text.includes("Rewound to checkpoint_new")),
      "the rewind result block to render"
    );

    expect(fs.readFileSync(argsFile, "utf8")).toContain("session rewind session_rewind checkpoint_new --json");
    expect(state.blocks.some((block) => block.type === "system" && block.text.includes("Rewound to checkpoint_new"))).toBe(true);
  });

  it("shows a visible tiny-session notification when /compact has nothing to compact", async () => {
    const state = createInitialState();
    state.sessionId = "session_tiny";
    const app = new App(state);
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-bin-compact-")), "crewcoder");
    fs.writeFileSync(bin, "#!/usr/bin/env bash\nprintf '%s\\n' '{\"compacted\":false}'\n", "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;

    for (const event of parseInputEvents("/compact\r")) {
      app.handleInput(event);
    }
    await waitFor(
      () => state.blocks.at(-1)?.type === "compaction" && (state.blocks.at(-1) as { status?: string }).status === "skipped",
      "the tiny-session compaction notice to render"
    );

    expect(state.running).toBe(false);
    expect(state.blocks.at(-1)).toMatchObject({
      type: "compaction",
      status: "skipped",
      percent: 100,
      message: "Nothing to compact yet — this session is still too small."
    });
  });

  it("selects slash commands from the popover with enter", () => {
    const state = createInitialState();
    state.blocks.push({ type: "system", text: "keep me until clear" });
    const app = new App(state);

    for (const event of parseInputEvents("/clear\r")) {
      app.handleInput(event);
    }

    expect(state.input).toBe("");
    expect(state.blocks).toEqual([]);
  });

  it("opens the system prompts picker with /prompts", async () => {
    const state = createInitialState();
    const app = new App(state);
    let opened = false;
    (app as unknown as { openSystemPromptsOverlay: () => Promise<void> }).openSystemPromptsOverlay = async () => {
      opened = true;
    };

    for (const event of parseInputEvents("/prompts\r")) {
      app.handleInput(event);
    }
    await waitFor(() => opened, "the system prompts overlay to open");

    expect(opened).toBe(true);
  });

  it("inserts a saved prompt command into the composer", async () => {
    const state = createInitialState();
    const app = new App(state);
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-bin-")), "crewcoder");
    fs.writeFileSync(bin, "#!/usr/bin/env bash\nprintf '%s\\n' '{\"name\":\"fix-tests\",\"path\":\"/tmp/fix-tests.md\",\"content\":\"Loaded fix-tests command\"}'\n", "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;

    for (const event of parseInputEvents("/commands fix-tests\r")) {
      app.handleInput(event);
    }
    await waitFor(() => state.input === "Loaded fix-tests command", "the saved prompt command to load into the composer");

    expect(state.input).toBe("Loaded fix-tests command");
    expect(state.inputCursor).toBe(state.input.length);
    expect(state.blocks.some((block) => block.type === "user")).toBe(false);
  });

  it("dispatches direct extension commands through command run", async () => {
    const state = createInitialState();
    const app = new App(state);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-bin-ext-"));
    const bin = path.join(tempDir, "crewcoder");
    const argsFile = path.join(tempDir, "args.txt");
    fs.writeFileSync(bin, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$CREWCODER_TEST_ARGS_FILE\"\nprintf '%s\\n' 'extension command ran'\n", "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;
    process.env.CREWCODER_TEST_ARGS_FILE = argsFile;
    process.env.CREWCODER_TUI_SYSTEM_LOGS = "1";

    for (const event of parseInputEvents("/ext.my-extension.hello name=Ada loud=true\r")) {
      app.handleInput(event);
    }
    await waitFor(
      () => state.blocks.some((block) => block.type === "system" && block.text === "extension command ran"),
      "the extension command output to render"
    );

    expect(fs.readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "command",
      "run",
      "ext.my-extension.hello",
      "name=Ada",
      "loud=true"
    ]);
    expect(state.blocks).toContainEqual({ type: "system", text: "extension command ran" });
    expect(state.blocks.some((block) => block.type === "user")).toBe(false);
  });

  it("selects workers as per-session mode targets and clears them when selecting built-in modes", async () => {
    const state = createInitialState();
    state.integrationProfile = "crewcode";
    const app = new App(state);
    (app as unknown as { listWorkers: () => Promise<Array<{ name: string; active: boolean; ownerName: string | null }>> }).listWorkers = async () => [
      { name: "Builder", active: false, ownerName: "Crew" }
    ];

    await (app as unknown as { selectModeOrWorker: (name: string) => Promise<void> }).selectModeOrWorker("Builder");

    expect(state.mode).toBe("general");
    expect(state.worker).toBe("Builder");

    await (app as unknown as { selectModeOrWorker: (name: string) => Promise<void> }).selectModeOrWorker("plugin");

    expect(state.mode).toBe("plugin");
    expect(state.worker).toBeUndefined();
  });

  it("opens the sessions overlay with both /sessions and /resume", () => {
    const state = createInitialState();
    const app = new App(state);
    let opened = 0;
    (app as unknown as { openSessionsOverlay: () => void }).openSessionsOverlay = () => { opened += 1; };

    for (const command of ["/sessions\r", "/resume\r"]) {
      for (const event of parseInputEvents(command)) app.handleInput(event);
    }

    expect(opened).toBe(2);
  });

  it("resumes selected sessions with their saved provider, model, and mode", () => {
    const state = createInitialState();
    state.provider = "codex";
    state.model = "gpt-5.4-mini";
    state.mode = "general";
    const app = new App(state);
    let resumeOptions: { provider: string; model?: string; mode: string; sessionId: string } | undefined;
    (app as unknown as { bridge: { resume: (options: { provider: string; model?: string; mode: string; sessionId: string }, onEvent: () => void) => void } }).bridge = {
      resume: (options) => { resumeOptions = options; }
    };

    (app as unknown as { resumeSelectedSession: (session: { id: string; startedAt: string; cwd: string; requestedMode: string; resolvedMode: string; prompt: string; provider?: string; model?: string }) => void }).resumeSelectedSession({
      id: "session_opencode",
      startedAt: "2026-06-29T00:00:00.000Z",
      cwd: state.cwd,
      requestedMode: "general",
      resolvedMode: "general",
      prompt: "old prompt",
      provider: "opencode",
      model: "minimax-2.5"
    });

    expect(state.provider).toBe("opencode");
    expect(state.model).toBe("minimax-2.5");
    expect(state.mode).toBe("general");
    expect(resumeOptions).toMatchObject({
      sessionId: "session_opencode",
      provider: "opencode",
      model: "minimax-2.5",
      mode: "general"
    });
  });

  it("restores the saved effort on resume instead of falling back to the default", () => {
    const state = createInitialState();
    state.effort = "low";
    const app = new App(state);
    type ResumeSession = { id: string; startedAt: string; cwd: string; requestedMode: string; resolvedMode: string; prompt: string; provider?: string; model?: string; effort?: string };
    let resumeOptions: { effort?: string } | undefined;
    (app as unknown as { bridge: { resume: (options: { effort?: string }, onEvent: () => void) => void } }).bridge = {
      resume: (options) => { resumeOptions = options; }
    };
    const resume = (app as unknown as { resumeSelectedSession: (session: ResumeSession) => void }).resumeSelectedSession.bind(app);
    const session: ResumeSession = {
      id: "session_effort",
      startedAt: "2026-06-29T00:00:00.000Z",
      cwd: state.cwd,
      requestedMode: "general",
      resolvedMode: "general",
      prompt: "old prompt",
      provider: "codex",
      model: "gpt-5.6-luna",
      effort: "xhigh"
    };

    resume(session);
    expect(state.effort).toBe("xhigh");
    expect(resumeOptions).toMatchObject({ effort: "xhigh" });

    // An effort the resumed provider/model does not support falls back to the
    // default rather than sending a value the provider will reject.
    resume({ ...session, id: "session_effort_unsupported", provider: "opencode", model: "claude-sonnet-4-6", effort: "xhigh" });
    expect(state.effort).toBe("low");

    resume({ ...session, id: "session_effort_none", provider: "opencode", model: "claude-sonnet-4-6", effort: "none" });
    expect(state.effort).toBe("none");
  });

  it("starts a fresh session with /new", () => {
    const state = createInitialState();
    state.sessionId = "session_existing";
    state.running = true;
    state.blocks = [{ type: "user", text: "old prompt" }, { type: "assistant", text: "old answer" }];
    state.changedFiles = ["src/old.ts"];
    state.viewportScroll = 5;
    state.viewportMaxScroll = 9;
    state.toolOutputExpanded = true;
    state.usage = { turns: 3, totalTokens: 123 };
    state.systemPrompt = "strict-review";
    const app = new App(state);
    let stopped = false;
    (app as unknown as { bridge: { stop: () => void } }).bridge.stop = () => { stopped = true; };

    for (const event of parseInputEvents("/new\r")) {
      app.handleInput(event);
    }

    expect(stopped).toBe(true);
    expect(state.sessionId).toBe("new");
    expect(state.running).toBe(false);
    expect(state.blocks).toEqual([]);
    expect(state.changedFiles).toEqual([]);
    expect(state.viewportScroll).toBe(0);
    expect(state.viewportMaxScroll).toBe(0);
    expect(state.toolOutputExpanded).toBe(false);
    expect(state.usage).toEqual({ turns: 0 });
    expect(state.systemPrompt).toBeUndefined();
  });

  it("reloads CLI metadata and rescans home ~/.crewcoder files", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-tui-home-"));
    process.env.HOME = home;
    delete process.env.CREWCODER_HOME;
    fs.mkdirSync(path.join(home, ".crewcoder", "logs"), { recursive: true });
    fs.writeFileSync(path.join(home, ".crewcoder", "logs", "note.txt"), "log", "utf8");
    fs.writeFileSync(path.join(home, ".crewcoder", "config.json"), JSON.stringify({
      integrationProfile: "crewcode",
      defaultMode: "plugin",
      defaultProvider: "opencode",
      defaultModel: "minimax-2.5"
    }), "utf8");
    const state = createInitialState();
    state.provider = "missing";
    state.model = "missing-model";
    state.mode = "general";
    const app = new App(state);
    (app as unknown as { loadProviders: () => Promise<unknown[]> }).loadProviders = async () => [{
      id: "opencode",
      title: "OpenCode",
      models: ["minimax-2.5"],
      defaultModel: "minimax-2.5"
    }];
    (app as unknown as { loadSessions: () => Promise<unknown[]> }).loadSessions = async () => [
      { id: "session_one" },
      { id: "session_two" }
    ];

    for (const event of parseInputEvents("/reload\r")) {
      app.handleInput(event);
    }
    await waitFor(
      () => state.blocks.at(-1)?.type === "system" && (state.blocks.at(-1) as { text: string }).text.includes("~/.crewcoder:"),
      "the reload summary block to render"
    );

    expect(state.running).toBe(false);
    expect(state.mode).toBe("plugin");
    expect(state.provider).toBe("opencode");
    expect(state.model).toBe("minimax-2.5");
    expect(state.systemPrompt).toBeUndefined();
    const last = state.blocks.at(-1);
    expect(last).toMatchObject({ type: "system" });
    if (last?.type !== "system") throw new Error("expected reload system block");
    expect(last.text).toContain("~/.crewcoder: 2 files");
    expect(last.text).toContain("1 provider");
    expect(last.text).toContain("2 sessions");
  });

  it("refuses to reload while CrewCoder is running", () => {
    const state = createInitialState();
    state.running = true;
    const app = new App(state);

    for (const event of parseInputEvents("/reload\r")) {
      app.handleInput(event);
    }

    expect(state.blocks.at(-1)).toEqual({ type: "error", text: "Cannot reload while CrewCoder is running. Use /stop first." });
  });

  it("supports explicit sidebar commands without adding transcript content", () => {
    const state = createInitialState();
    const app = new App(state);

    for (const event of parseInputEvents("/sidebar on\r")) app.handleInput(event);
    expect(state.blocks.some((block) => block.type === "user" || block.type === "assistant")).toBe(false);
    expect(app.render({ theme: crewCoderTheme, size: { width: 100, height: 32 } }).map(stripAnsi).every((line) => line[73] === "│")).toBe(true);

    for (const event of parseInputEvents("/sidebar off\r")) app.handleInput(event);
    expect(state.blocks.some((block) => block.type === "user" || block.type === "assistant")).toBe(false);
    expect(app.render({ theme: crewCoderTheme, size: { width: 100, height: 32 } }).map(stripAnsi).every((line) => line[73] === "│")).toBe(false);
  });

  it("forces a renderer repaint with /repaint", () => {
    const state = createInitialState();
    const app = new App(state);
    let repaintCount = 0;
    app.repaint = () => { repaintCount += 1; };

    for (const event of parseInputEvents("/repaint\r")) {
      app.handleInput(event);
    }

    expect(repaintCount).toBe(1);
    expect(app.render({ theme: crewCoderTheme, size: { width: 80, height: 24 } }).map(stripAnsi).join("\n")).toContain("✓ Repainted TUI");
  });

  it("requests a live compaction preview with /compact edit while running", () => {
    const state = createInitialState();
    const app = new App(state);
    let requested = false;
    (app as unknown as { bridge: { running: boolean; requestCompactionPreview: () => boolean } }).bridge = {
      running: true,
      requestCompactionPreview: () => { requested = true; return true; }
    };

    for (const event of parseInputEvents("/compact edit\r")) {
      app.handleInput(event);
    }

    expect(requested).toBe(true);
  });

  it("opens the compaction preview editor and applies an edited summary over the control channel", () => {
    const state = createInitialState();
    state.blocks = [];
    const app = new App(state);
    let resolved: { previewId: string; approved: boolean; summary?: string } | undefined;
    (app as unknown as { bridge: { running: boolean; resolveCompactionPreview: (previewId: string, approved: boolean, summary?: string) => boolean } }).bridge = {
      running: true,
      resolveCompactionPreview: (previewId: string, approved: boolean, summary?: string) => { resolved = { previewId, approved, summary }; return true; }
    };

    (app as unknown as { handleCrewCoderEvent: (event: any) => void }).handleCrewCoderEvent({
      type: "session_compaction_preview",
      previewId: "preview_1",
      summary: "proposed summary",
      source: "model",
      originalMessageCount: 20,
      retainedMessageCount: 8
    });

    expect((app as unknown as { activePopover?: { kind?: string; previewId?: string } }).activePopover).toMatchObject({ kind: "compaction_preview", previewId: "preview_1" });
    expect(app.render({ theme: crewCoderTheme, size: { width: 90, height: 28 } }).map(stripAnsi).join("\n")).toContain("Edit compaction summary");

    for (const ch of " edited") app.handleInput({ name: ch, sequence: ch, ctrl: false, meta: false, shift: false });
    app.handleInput({ name: "s", sequence: "s", ctrl: true, meta: false, shift: false });

    expect(resolved).toEqual({ previewId: "preview_1", approved: true, summary: "proposed summary edited" });
    expect((app as unknown as { activePopover?: unknown }).activePopover).toBeUndefined();
  });

  it("cancels the compaction preview with escape", () => {
    const state = createInitialState();
    state.blocks = [];
    const app = new App(state);
    let resolved: { previewId: string; approved: boolean; summary?: string } | undefined;
    (app as unknown as { bridge: { running: boolean; resolveCompactionPreview: (previewId: string, approved: boolean, summary?: string) => boolean } }).bridge = {
      running: true,
      resolveCompactionPreview: (previewId: string, approved: boolean, summary?: string) => { resolved = { previewId, approved, summary }; return true; }
    };

    (app as unknown as { handleCrewCoderEvent: (event: any) => void }).handleCrewCoderEvent({
      type: "session_compaction_preview",
      previewId: "preview_2",
      summary: "proposed",
      source: "model",
      originalMessageCount: 20,
      retainedMessageCount: 8
    });
    app.handleInput({ name: "escape", sequence: "", ctrl: false, meta: false, shift: false });

    expect(resolved).toEqual({ previewId: "preview_2", approved: false, summary: undefined });
    expect((app as unknown as { activePopover?: unknown }).activePopover).toBeUndefined();
  });

  it("persists /thinking off through config and updates TUI state", async () => {
    const state = createInitialState();
    const app = new App(state);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-thinking-"));
    const argsFile = path.join(dir, "args.txt");
    const bin = path.join(dir, "crewcoder");
    fs.writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s' "$*" > ${JSON.stringify(argsFile)}\n`, "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;

    for (const event of parseInputEvents("/thinking off\r")) app.handleInput(event);
    await waitFor(() => fs.existsSync(argsFile) && state.thinkingEnabled === false, "thinking config update");

    expect(fs.readFileSync(argsFile, "utf8")).toBe("config set thinkingEnabled false");
    expect(state.thinkingEnabled).toBe(false);
  });

  it("rejects invalid /thinking values without changing state", () => {
    const state = createInitialState();
    const app = new App(state);
    for (const event of parseInputEvents("/thinking maybe\r")) app.handleInput(event);
    expect(state.thinkingEnabled).toBe(true);
    expect(state.blocks.at(-1)).toEqual({ type: "error", text: "Usage: /thinking on|off|status" });
  });

  it("runs a named worker crew with the active model settings", async () => {
    const state = createInitialState();
    state.provider = "test-provider";
    state.model = "test-model";
    const app = new App(state);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-crew-"));
    const argsFile = path.join(dir, "args.txt");
    const bin = path.join(dir, "crewcoder");
    fs.writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s' "$*" > ${JSON.stringify(argsFile)}\nprintf 'Crew run complete\\n'\n`, "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;

    for (const event of parseInputEvents("/crew architect,reviewer Build checkout validation\r")) app.handleInput(event);
    await waitFor(() => fs.existsSync(argsFile) && !state.running, "the crew command to finish");

    const args = fs.readFileSync(argsFile, "utf8");
    expect(args).toContain("crew run --workers architect,reviewer Build checkout validation");
    expect(args).toContain("--provider test-provider");
    expect(args).toContain("--model test-model");
  });

  it("hands off the active session and switches to the child session", async () => {
    const state = createInitialState();
    state.sessionId = "session_source";
    const app = new App(state);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-handoff-"));
    const argsFile = path.join(dir, "args.txt");
    const bin = path.join(dir, "crewcoder");
    fs.writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s' "$*" > ${JSON.stringify(argsFile)}\nprintf '%s\\n' '{"sessionId":"session_child","worker":"reviewer","summary":"Review complete"}'\n`, "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;

    for (const event of parseInputEvents("/handoff worker:reviewer Review the implementation\r")) app.handleInput(event);
    await waitFor(() => state.sessionId === "session_child" && !state.running, "the handoff to finish");

    expect(fs.readFileSync(argsFile, "utf8")).toContain("crew handoff worker:reviewer session_source Review the implementation");
    expect(state.worker).toBe("reviewer");
    expect(state.blocks).toContainEqual({ type: "assistant", text: "Review complete" });
  });
});

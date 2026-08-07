import { describe, expect, it } from "vitest";
import { App, formatBudgetTokens, parseBudgetInput } from "../components/App.js";
import { commandOptions } from "../components/CommandPalette.js";
import { createInitialState } from "../state/tui-store.js";
import { parseInputEvents } from "../tui/input.js";

type RunOptions = { budget?: number };

function appWithCapturedRun(state: ReturnType<typeof createInitialState>) {
  const app = new App(state);
  const captured: { run?: RunOptions; resume?: RunOptions } = {};
  (app as unknown as { bridge: Record<string, unknown> }).bridge = {
    running: false,
    stop() {},
    run(options: RunOptions) { captured.run = options; },
    resume(options: RunOptions) { captured.resume = options; }
  };
  return { app, captured };
}

function send(app: App, text: string): void {
  for (const event of parseInputEvents(`${text}\r`)) app.handleInput(event);
}

describe("/set-budget", () => {
  it("is offered in the command palette", () => {
    const option = commandOptions.find((item) => item.command === "/set-budget");
    expect(option).toBeDefined();
    expect(option?.description).toContain("/set-budget 200k");
  });

  it("parses shorthand the same way the agent CLI does", () => {
    expect(parseBudgetInput("200k")).toBe(200_000);
    expect(parseBudgetInput("1.5m")).toBe(1_500_000);
    expect(parseBudgetInput("250000")).toBe(250_000);
    expect(parseBudgetInput("250,000")).toBe(250_000);
    expect(parseBudgetInput("1_000")).toBe(1_000);
    expect(parseBudgetInput("abc")).toBeUndefined();
    expect(parseBudgetInput("0")).toBeUndefined();
    expect(parseBudgetInput("-5")).toBeUndefined();
    expect(parseBudgetInput("")).toBeUndefined();
  });

  it("formats budgets back to readable shorthand", () => {
    expect(formatBudgetTokens(200_000)).toBe("200k");
    expect(formatBudgetTokens(1_500_000)).toBe("1.5m");
    expect(formatBudgetTokens(500)).toBe("500");
  });

  it("sets a budget and passes it to the next run", () => {
    const state = createInitialState();
    const { app, captured } = appWithCapturedRun(state);

    send(app, "/set-budget 200k");
    expect(state.tokenBudget).toBe(200_000);
    expect(state.usage.tokenBudget).toBe(200_000);
    expect(state.blocks.some((block) => block.type === "system" && block.text.includes("200k"))).toBe(true);

    send(app, "do the thing");
    expect(captured.run?.budget).toBe(200_000);
  });

  it("passes the budget when resuming an existing session", () => {
    const state = createInitialState();
    state.sessionId = "session_live";
    const { app, captured } = appWithCapturedRun(state);

    send(app, "/set-budget 50k");
    send(app, "keep going");

    expect(captured.resume?.budget).toBe(50_000);
  });

  it("clears the budget with off", () => {
    const state = createInitialState();
    const { app, captured } = appWithCapturedRun(state);

    send(app, "/set-budget 200k");
    send(app, "/set-budget off");

    expect(state.tokenBudget).toBeUndefined();
    expect(state.usage.tokenBudget).toBeUndefined();

    send(app, "unbounded please");
    expect(captured.run?.budget).toBeUndefined();
  });

  it("reports status without changing anything", () => {
    const state = createInitialState();
    const { app } = appWithCapturedRun(state);

    send(app, "/set-budget");
    expect(state.blocks.at(-1)).toMatchObject({ type: "system", text: expect.stringContaining("No token budget set") });

    send(app, "/set-budget 1m");
    send(app, "/set-budget status");
    expect(state.tokenBudget).toBe(1_000_000);
    expect(state.blocks.at(-1)).toMatchObject({ type: "system", text: expect.stringContaining("1m") });
  });

  it("rejects invalid input without setting a budget", () => {
    const state = createInitialState();
    const { app } = appWithCapturedRun(state);

    send(app, "/set-budget banana");

    expect(state.tokenBudget).toBeUndefined();
    expect(state.blocks.at(-1)).toMatchObject({ type: "error", text: expect.stringContaining("Usage: /set-budget") });
  });

  it("does not leak a budget into a fresh session", () => {
    const state = createInitialState();
    const { app, captured } = appWithCapturedRun(state);

    send(app, "/set-budget 200k");
    send(app, "/new");

    expect(state.tokenBudget).toBeUndefined();
    send(app, "fresh start");
    expect(captured.run?.budget).toBeUndefined();
  });

  it("carries the budget into a budget-exhaustion handoff instead of going unbounded", () => {
    const state = createInitialState();
    state.sessionId = "session_old";
    const { app, captured } = appWithCapturedRun(state);

    send(app, "/set-budget 200k");
    (app as unknown as { launchBudgetHandoff(handoff: { sourceSessionId: string; summary: string }): void })
      .launchBudgetHandoff({ sourceSessionId: "session_old", summary: "- did half the work" });

    expect(captured.run?.budget).toBe(200_000);
    expect(state.tokenBudget).toBe(200_000);
  });
});

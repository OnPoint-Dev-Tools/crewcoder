import { expect, it } from "vitest";
import { CodexProgress } from "../crewcoder-agent/src/providers/codex-progress.js";
import { createJsonEventSink } from "../crewcoder-agent/src/core/json-event-stream.js";
import { translateEvent } from "../crewcoder-agent/src/acp/event-translator.js";
import { applyCrewCoderEvent } from "../crewcoder-tui/src/state/event-reducer.js";
import { createInitialState } from "../crewcoder-tui/src/state/tui-store.js";
import { MainViewport } from "../crewcoder-tui/src/components/MainViewport.js";
import { crewCoderTheme } from "../crewcoder-tui/src/theme/theme.js";
import { stripAnsi } from "../crewcoder-tui/src/tui/ansi.js";

it("preserves summary item and section boundaries through the portable terminal stream", async () => {
  const state = new CodexProgress();
  const lines: string[] = [];
  const sink = createJsonEventSink(line => { lines.push(line); });
  const updates = [
    ...state.handle("item/reasoning/summaryTextDelta", { itemId: "a", summaryIndex: 0, delta: "**Tracing embedded agent execution**" }),
    ...state.handle("item/completed", { item: { type: "reasoning", id: "a", summary: ["**Tracing embedded agent execution**"], content: [] } }),
    ...state.handle("item/reasoning/summaryPartAdded", { itemId: "b", summaryIndex: 0 }),
    ...state.handle("item/reasoning/summaryTextDelta", { itemId: "b", summaryIndex: 0, delta: "**Awaiting TUI" }),
    ...state.handle("item/reasoning/summaryTextDelta", { itemId: "b", summaryIndex: 0, delta: " source access**" }),
    ...state.handle("item/reasoning/summaryPartAdded", { itemId: "b", summaryIndex: 1 }),
    ...state.handle("item/reasoning/summaryTextDelta", { itemId: "b", summaryIndex: 1, delta: "The source directory is required." }),
    ...state.handle("item/completed", { item: { type: "reasoning", id: "b", summary: ["**Awaiting TUI source access**", "The source directory is required. I will inspect its renderer."], content: [] } }),
  ];
  for (const emission of updates) await sink({ type: "thinking_delta", text: emission.delta, progress: emission.progress });
  expect(lines.map(line => JSON.parse(line).text).join("")).toBe(
    "**Tracing embedded agent execution**\n\n**Awaiting TUI source access**\n\nThe source directory is required. I will inspect its renderer."
  );
  const terminal = createInitialState();
  terminal.blocks = [];
  for (const line of lines) applyCrewCoderEvent(terminal, JSON.parse(line));
  expect(terminal.blocks).toEqual([{ type: "thinking", text: lines.map(line => JSON.parse(line).text).join("") }]);
  const rendered = new MainViewport(terminal).render({ theme: crewCoderTheme, size: { width: 120, height: 24 } }).map(stripAnsi);
  const heading = rendered.findIndex(line => line.includes("**Awaiting TUI source access**"));
  const body = rendered.findIndex(line => line.includes("The source directory is required."));
  expect(heading).toBeGreaterThan(0);
  expect(body).toBeGreaterThan(heading + 1);
  expect(rendered.join("\n")).toContain("THOUGHTS...");
  expect(updates.at(-1)?.progress.sections).toEqual(["**Awaiting TUI source access**", "The source directory is required. I will inspect its renderer."]);
  expect(translateEvent({ type: "thinking_delta", text: updates.at(-1)!.delta, progress: updates.at(-1)!.progress })).toMatchObject({
    _meta: { "crewcoder/progress": { text: "**Awaiting TUI source access**\n\nThe source directory is required. I will inspect its renderer.", completed: true } }
  });
});

it("separates completion-only sections and raw content without duplicating live body text", () => {
  const state = new CodexProgress();
  const deltas = [
    ...state.handle("item/completed", { item: { type: "reasoning", id: "a", summary: ["Heading", "Body"], content: [] } }),
    ...state.handle("item/reasoning/textDelta", { itemId: "a", contentIndex: 0, delta: "Raw body" }),
    ...state.handle("item/completed", { item: { type: "reasoning", id: "a", summary: ["Heading", "Body"], content: ["Raw body completed"] } }),
    ...state.handle("item/completed", { item: { type: "reasoning", id: "a", summary: ["Heading", "Body"], content: ["Raw body completed"] } }),
  ];
  expect(deltas.map(x => x.delta).join("")).toBe("Heading\n\nBody\n\nRaw body completed");
});

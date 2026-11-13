import { expect, it } from "vitest";
import { CodexProgress } from "../crewcoder-agent/src/providers/codex-progress.js";
import { createJsonEventSink } from "../crewcoder-agent/src/core/json-event-stream.js";
import { translateEvent } from "../crewcoder-agent/src/acp/event-translator.js";
import { applyCrewCoderEvent } from "../crewcoder-tui/src/state/event-reducer.js";
import { createInitialState } from "../crewcoder-tui/src/state/tui-store.js";

it("keeps full summary bodies and public commentary in terminal thinking, with final replies separate", async () => {
  const progress = new CodexProgress();
  const lines: string[] = [];
  const sink = createJsonEventSink(line => { lines.push(line); });
  const events = [
    ...progress.handle("item/reasoning/summaryTextDelta", { itemId: "r", summaryIndex: 0, delta: "**Checking ownership**\n\nCompare the source and destination before choosing a restore." }),
    ...progress.handle("item/started", { item: { id: "c", type: "agentMessage", phase: "commentary" } }),
    ...progress.handle("item/agentMessage/delta", { itemId: "c", delta: "I will inspect the files first." }),
    ...progress.handle("item/completed", { item: { id: "c", type: "agentMessage", phase: "commentary", text: "I will inspect the files first. Then check the tests." } })
  ];
  for (const e of events) await sink({ type: "thinking_delta", text: e.delta, progress: e.progress });
  await sink({ type: "assistant_delta", text: "I will inspect the files first. Then check the tests.", phase: "commentary" });
  await sink({ type: "assistant_delta", text: "Inspection complete.", phase: "final_answer" });
  const state = createInitialState();
  state.blocks = [];
  for (const line of lines) applyCrewCoderEvent(state, JSON.parse(line));
  expect(state.blocks).toMatchObject([
    { type: "thinking", text: "**Checking ownership**\n\nCompare the source and destination before choosing a restore.\n\nI will inspect the files first. Then check the tests." },
    { type: "assistant", text: "Inspection complete." }
  ]);
  expect(translateEvent({ type: "assistant_delta", text: "I will inspect the files first.", phase: "commentary" })).toMatchObject({
    sessionUpdate: "agent_message_chunk", content: { text: "I will inspect the files first." }
  });
  expect(translateEvent({ type: "thinking_delta", text: events.at(-1)!.delta, progress: events.at(-1)!.progress })).toMatchObject({
    _meta: { "crewcoder/progress": { kind: "commentary", text: "I will inspect the files first. Then check the tests.", completed: true } }
  });
  expect(progress.handle("item/completed", { item: { id: "c", type: "agentMessage", phase: "commentary", text: "I will inspect the files first. Then check the tests." } })).toEqual([]);
});

it("captures completion-only commentary and leaves final answers outside progress", () => {
  const state = new CodexProgress();
  expect(state.handle("item/completed", { item: { id: "c", type: "agentMessage", phase: "commentary", text: "Checking tests." } })[0]?.progress).toMatchObject({ kind: "commentary", text: "Checking tests.", completed: true });
  expect(state.handle("item/completed", { item: { id: "f", type: "agentMessage", phase: "final_answer", text: "Done." } })).toEqual([]);
});

import { describe, expect, it } from "vitest";
import { applyCrewCoderEvent } from "../state/event-reducer.js";
import { splitNodeWarnings } from "../state/node-warnings.js";
import { createInitialState } from "../state/tui-store.js";

const SDK_WARNING = "(node:823679) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked for: Read, Grep";
const TRACE_HINT = "(Use `node --trace-warnings ...` to show where the warning was created)";

describe("Node warnings on agent stderr", () => {
  it("splits warnings and the trace hint from real stderr", () => {
    expect(splitNodeWarnings(`${SDK_WARNING}\n${TRACE_HINT}\n`)).toEqual({ warnings: [SDK_WARNING], rest: "" });
    expect(splitNodeWarnings("(node:1) ExperimentalWarning: FFI is experimental\n")).toEqual({ warnings: ["(node:1) ExperimentalWarning: FFI is experimental"], rest: "" });
    expect(splitNodeWarnings(`${SDK_WARNING}\nError: provider crashed\n`)).toEqual({ warnings: [SDK_WARNING], rest: "Error: provider crashed\n" });
  });

  it("keeps ordinary stderr untouched, including text that merely mentions warnings", () => {
    expect(splitNodeWarnings("Warning: disk almost full\n")).toEqual({ warnings: [], rest: "Warning: disk almost full\n" });
    expect(splitNodeWarnings("TypeError: x is undefined")).toEqual({ warnings: [], rest: "TypeError: x is undefined" });
  });

  it("does not draw a Node warning as an error block, but still draws real stderr", () => {
    const state = createInitialState();
    applyCrewCoderEvent(state, { type: "stderr", text: `${SDK_WARNING}\n${TRACE_HINT}\n` });
    expect(state.blocks.filter((block) => block.type === "error")).toEqual([]);

    applyCrewCoderEvent(state, { type: "stderr", text: `${SDK_WARNING}\nfatal: not a git repository\n` });
    expect(state.blocks.filter((block) => block.type === "error")).toEqual([{ type: "error", text: "fatal: not a git repository\n" }]);
  });
});

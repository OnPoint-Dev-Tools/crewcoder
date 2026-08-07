import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../components/App.js";
import { MainViewport } from "../components/MainViewport.js";
import { createInitialState } from "../state/tui-store.js";
import { crewCoderTheme } from "../theme/theme.js";
import { parseInputEvents } from "../tui/input.js";
import { stripAnsi } from "../tui/ansi.js";

async function waitFor(condition: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

/** Fake `crewcoder` binary that records its args and prints a canned stdout. */
function stubBin(stdout: string): { bin: string; argsFile: string } {
  const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-why-args-")), "args.txt");
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-bin-why-")), "crewcoder");
  fs.writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s' "$*" > ${JSON.stringify(argsFile)}\nprintf '%s\\n' ${JSON.stringify(stdout)}\n`, "utf8");
  fs.chmodSync(bin, 0o755);
  return { bin, argsFile };
}

const MODEL_RESPONSE = JSON.stringify({
  explained: true,
  source: "model",
  explanation: "- It read the fetch helper before editing\n- Because the request named that file",
  decision: {
    sessionId: "session_why",
    messageIndex: 3,
    toolCalls: [{ name: "read", arguments: { path: "src/fetch.ts" }, ok: true }],
    changedFiles: ["src/fetch.ts"]
  }
});

describe("/why", () => {
  const originalBin = process.env.CREWCODER_BIN;

  afterEach(() => {
    if (originalBin === undefined) delete process.env.CREWCODER_BIN;
    else process.env.CREWCODER_BIN = originalBin;
  });

  it("shells out to session why and renders a why block", async () => {
    const state = createInitialState();
    state.sessionId = "session_why";
    state.provider = "codex";
    state.model = "gpt-test";
    const app = new App(state);
    const { bin, argsFile } = stubBin(MODEL_RESPONSE);
    process.env.CREWCODER_BIN = bin;

    for (const event of parseInputEvents("/why\r")) app.handleInput(event);
    await waitFor(() => state.blocks.at(-1)?.type === "why", "the why block to render");

    expect(fs.readFileSync(argsFile, "utf8")).toBe(
      `session why session_why --json --provider codex --effort ${state.effort} --model gpt-test`
    );
    expect(state.blocks.at(-1)).toEqual({
      type: "why",
      decision: {
        explanation: "- It read the fetch helper before editing\n- Because the request named that file",
        source: "model",
        fallbackReason: undefined,
        toolCalls: ["read"],
        changedFiles: ["src/fetch.ts"]
      }
    });
  });

  it("keeps the explanation out of the session transcript", async () => {
    const state = createInitialState();
    state.sessionId = "session_why";
    const app = new App(state);
    process.env.CREWCODER_BIN = stubBin(MODEL_RESPONSE).bin;

    for (const event of parseInputEvents("/why\r")) app.handleInput(event);
    await waitFor(() => state.blocks.at(-1)?.type === "why", "the why block to render");

    // /why must not enqueue a user turn or an assistant turn: it explains work
    // already done instead of adding more to the session.
    expect(state.blocks.some((block) => block.type === "user" || block.type === "assistant")).toBe(false);
  });

  it("reports that there is nothing to explain before the first turn", () => {
    const state = createInitialState();
    const app = new App(state);

    for (const event of parseInputEvents("/why\r")) app.handleInput(event);

    expect(state.blocks.at(-1)).toEqual({ type: "error", text: "Nothing to explain yet: this session has no agent turn." });
  });

  it("surfaces a backend failure as an error block", async () => {
    const state = createInitialState();
    state.sessionId = "session_why";
    const app = new App(state);
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-bin-why-fail-")), "crewcoder");
    fs.writeFileSync(bin, "#!/usr/bin/env bash\necho 'session not found' >&2\nexit 1\n", "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;

    for (const event of parseInputEvents("/why\r")) app.handleInput(event);
    await waitFor(() => state.blocks.at(-1)?.type === "error", "the error block to render");

    expect(state.blocks.at(-1)).toMatchObject({ type: "error", text: "session not found" });
  });

  it("renders a transcript fallback with its reason instead of passing it off as reasoning", () => {
    const state = createInitialState();
    state.blocks = [{
      type: "why",
      decision: {
        explanation: "- It ran bash(command: npm test) — failed",
        source: "transcript",
        fallbackReason: "401 unauthorized",
        toolCalls: ["bash"],
        changedFiles: []
      }
    }];
    const viewport = new MainViewport(state);

    const text = viewport.render({ theme: crewCoderTheme, size: { width: 80, height: 24 } }).map(stripAnsi).join("\n");

    expect(text).toContain("WHY");
    expect(text).toContain("transcript readout");
    expect(text).toContain("The model explainer was not used: 401 unauthorized");
    expect(text).toContain("It ran bash(command: npm test)");
  });

  it("labels a model explanation as such", () => {
    const state = createInitialState();
    state.blocks = [{
      type: "why",
      decision: { explanation: "- It read the helper first", source: "model", toolCalls: ["read"], changedFiles: ["src/fetch.ts"] }
    }];
    const viewport = new MainViewport(state);

    const text = viewport.render({ theme: crewCoderTheme, size: { width: 80, height: 24 } }).map(stripAnsi).join("\n");

    expect(text).toContain("model explanation");
    expect(text).not.toContain("transcript readout");
    expect(text).toContain("files: src/fetch.ts");
  });
});

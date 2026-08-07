import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CREWCODER_SDK_API_VERSION,
  CREWCODER_SDK_VERSION,
  CrewCoderError,
  createCrewCoderSession,
  type ModelClient
} from "../index.js";

const originalHome = process.env.CREWCODER_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalHome;
});

describe("CrewCoder SDK lifecycle contract", () => {
  it("exports explicit SDK and API versions", () => {
    expect(CREWCODER_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CREWCODER_SDK_API_VERSION).toBe("1.0");
  });

  it("persists a session and resumes it from a new SDK object", async () => {
    const home = temporaryDirectory("crewcoder-sdk-home-");
    process.env.CREWCODER_HOME = home;
    let turns = 0;
    const modelClient = deterministicModel(() => `turn ${++turns}`);
    const firstSession = createCrewCoderSession({ cwd: temporaryDirectory("crewcoder-sdk-workspace-"), modelClient });

    const first = await firstSession.prompt("first durable prompt");
    expect(first.sessionFile).toBeTruthy();
    expect(fs.existsSync(first.sessionFile!)).toBe(true);

    const resumedSession = createCrewCoderSession({ sessionId: first.sessionId, modelClient });
    const resumed = await resumedSession.prompt("continue durable prompt");

    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.messages.length).toBeGreaterThan(first.messages.length);
    expect(turns).toBe(2);
  });

  it("routes built-in text reads through the host filesystem", async () => {
    let turns = 0;
    const requestedPaths: string[] = [];
    const modelClient: ModelClient = {
      async complete() {
        turns += 1;
        if (turns === 1) {
          return {
            role: "assistant",
            content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "virtual.txt" } }],
            stopReason: "tool_calls",
            timestamp: Date.now()
          };
        }
        return assistantMessage("read complete");
      }
    };
    const cwd = temporaryDirectory("crewcoder-sdk-workspace-");
    const session = createCrewCoderSession({
      cwd,
      persistSession: false,
      modelClient,
      textFiles: {
        async readTextFile(absolutePath) {
          requestedPaths.push(absolutePath);
          return "virtual host content";
        }
      }
    });

    const result = await session.prompt("read the virtual file");

    expect(requestedPaths).toEqual([path.join(cwd, "virtual.txt")]);
    expect(result.messages.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes("virtual host content"))).toBe(true);
  });

  it("grants built-in tools access to SDK session external directories", async () => {
    const cwd = temporaryDirectory("crewcoder-sdk-workspace-");
    const external = temporaryDirectory("crewcoder-sdk-external-");
    const file = path.join(external, "shared.txt");
    fs.writeFileSync(file, "shared content", "utf8");
    let turns = 0;
    const modelClient: ModelClient = {
      async complete() {
        turns += 1;
        return turns === 1
          ? { role: "assistant", content: [{ type: "toolCall", id: "read-external", name: "read", arguments: { path: file } }], stopReason: "tool_calls", timestamp: Date.now() }
          : assistantMessage("external read complete");
      }
    };
    const session = createCrewCoderSession({ cwd, externalDirectories: [external], persistSession: false, modelClient });

    const result = await session.prompt("read the shared file");

    expect(result.externalDirectories).toEqual([external]);
    expect(result.messages.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes("shared content"))).toBe(true);
  });

  it("queues a follow-up while the provider call is active", async () => {
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const firstStarted = promiseWithResolver<void>();
    const modelClient: ModelClient = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          firstStarted.resolve();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
          return assistantMessage("first response");
        }
        return assistantMessage("follow-up response");
      }
    };
    const session = createCrewCoderSession({ cwd: temporaryDirectory("crewcoder-sdk-workspace-"), persistSession: false, modelClient });

    const running = session.prompt("start");
    await firstStarted.promise;
    expect(session.followUp("also check docs")).toBe(true);
    releaseFirst?.();
    const result = await running;

    expect(calls).toBe(2);
    expect(result.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("also check docs"))).toBe(true);
  });

  it("uses typed errors for concurrent prompts, abort, and disposal", async () => {
    const started = promiseWithResolver<void>();
    const modelClient: ModelClient = {
      async complete(_input, signal) {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) { reject(signal.reason); return; }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return assistantMessage("unreachable");
      }
    };
    const session = createCrewCoderSession({ cwd: temporaryDirectory("crewcoder-sdk-workspace-"), persistSession: false, modelClient });
    const running = session.prompt("block until aborted");
    await started.promise;

    const concurrent = session.prompt("must reject");
    await expect(concurrent).rejects.toMatchObject({ code: "SESSION_RUNNING" });
    expect(session.abort()).toBe(true);
    await expect(running).rejects.toBeDefined();
    expect(session.isRunning).toBe(false);

    session.dispose();
    expect(() => session.subscribe(() => {})).toThrow(CrewCoderError);
    await expect(session.prompt("after dispose")).rejects.toMatchObject({ code: "SESSION_DISPOSED" });
  });
});

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function deterministicModel(text: () => string): ModelClient {
  return { async complete() { return assistantMessage(text()); } };
}

function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    stopReason: "end" as const,
    timestamp: Date.now()
  };
}

function promiseWithResolver<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

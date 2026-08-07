import { describe, expect, it } from "vitest";
import { runProcessProvider } from "../providers/process-provider.js";
import type { ProviderDefinition } from "../providers/types.js";

describe("process provider", () => {
  it("emits backend debug events for provider lifecycle and output", async () => {
    const events: Array<{ source: string; message: string; details?: Record<string, unknown> }> = [];
    const provider: ProviderDefinition = {
      id: "fake",
      title: "Fake Provider",
      kind: "extension",
      runtime: "process",
      command: "bash",
      args: ["-lc", "printf 'assistant text\\n'; printf 'provider warning\\n' >&2"]
    };

    const result = await runProcessProvider({
      provider,
      prompt: "test",
      cwd: process.cwd(),
      debug: {
        event: async (event) => {
          events.push(event);
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("assistant text");
    expect(result.stderr).toContain("provider warning");
    expect(result.text).not.toContain("provider warning");
    expect(events.map((event) => event.message)).toEqual(expect.arrayContaining([
      "starting provider process",
      "provider stdout chunk",
      "provider stderr chunk",
      "provider process closed"
    ]));
    expect(events.find((event) => event.message === "provider process closed")?.details).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it("omits model flags when no concrete model is selected", async () => {
    const provider: ProviderDefinition = {
      id: "fake",
      title: "Fake Provider",
      kind: "extension",
      runtime: "process",
      command: "bash",
      args: ["-lc", "printf '%s' \"$@\"", "--", "run", "{{modelArg:--model}}", "{{prompt}}"]
    };

    const result = await runProcessProvider({ provider, prompt: "hello", cwd: process.cwd(), model: "default" });

    expect(result.text).toBe("runhello");
  });

  it("adds model flags when a concrete model is selected", async () => {
    const provider: ProviderDefinition = {
      id: "fake",
      title: "Fake Provider",
      kind: "extension",
      runtime: "process",
      command: "bash",
      args: ["-lc", "printf '%s|' \"$@\"", "--", "run", "{{modelArg:--model}}", "{{prompt}}"]
    };

    const result = await runProcessProvider({ provider, prompt: "hello", cwd: process.cwd(), model: "m1" });

    expect(result.text).toBe("run|--model|m1|hello|");
  });
});

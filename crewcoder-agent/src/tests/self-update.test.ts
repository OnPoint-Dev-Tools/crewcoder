import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { compareVersions, confirmWithArrowKeys, runSelfUpdate } from "../core/self-update.js";

function outputBuffer(): { output: Pick<NodeJS.WriteStream, "write">; text: () => string } {
  let value = "";
  return {
    output: { write: (chunk) => { value += String(chunk); return true; } },
    text: () => value
  };
}

describe("CrewCoder self-update", () => {
  it("reports an exact up-to-date message without installing", async () => {
    const installLatest = vi.fn(async () => undefined);
    const buffer = outputBuffer();
    const result = await runSelfUpdate({}, {
      currentVersion: "1.2.3",
      stdout: buffer.output,
      getLatestVersion: async () => "1.2.3",
      installLatest
    });

    expect(result).toBe("up-to-date");
    expect(buffer.text()).toBe("current version is up to date\n");
    expect(installLatest).not.toHaveBeenCalled();
  });

  it("shows both versions and installs latest when --yes is set", async () => {
    const installLatest = vi.fn(async () => undefined);
    const confirm = vi.fn(async () => false);
    const buffer = outputBuffer();
    const result = await runSelfUpdate({ yes: true }, {
      currentVersion: "1.2.3",
      stdout: buffer.output,
      getLatestVersion: async () => "1.3.0",
      installLatest,
      confirm
    });

    expect(result).toBe("updated");
    expect(buffer.text()).toContain("CrewCoder update available: 1.2.3 -> 1.3.0");
    expect(installLatest).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not install when confirmation is declined", async () => {
    const installLatest = vi.fn(async () => undefined);
    const buffer = outputBuffer();
    const result = await runSelfUpdate({}, {
      currentVersion: "1.2.3",
      stdout: buffer.output,
      getLatestVersion: async () => "2.0.0",
      installLatest,
      confirm: async () => false
    });

    expect(result).toBe("declined");
    expect(buffer.text()).toContain("Update cancelled.");
    expect(installLatest).not.toHaveBeenCalled();
  });

  it("refuses malformed or prerelease registry versions", async () => {
    await expect(runSelfUpdate({ yes: true }, {
      currentVersion: "1.2.3",
      getLatestVersion: async () => "2.0.0-beta.1",
      installLatest: async () => undefined
    })).rejects.toThrow("Invalid npm latest version");
  });

  it("compares stable semantic versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "2.0.1")).toBeLessThan(0);
  });

  it("uses arrow keys and Enter for the interactive Yes/No choice", async () => {
    const input = new EventEmitter() as EventEmitter & {
      isTTY: boolean;
      setRawMode: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
    };
    input.isTTY = true;
    input.setRawMode = vi.fn();
    input.resume = vi.fn();
    input.pause = vi.fn();
    const buffer = outputBuffer();
    const answer = confirmWithArrowKeys("Install?", input as unknown as Parameters<typeof confirmWithArrowKeys>[1], buffer.output);
    input.emit("keypress", undefined, { name: "right", ctrl: false });
    input.emit("keypress", "\r", { name: "return", ctrl: false });

    await expect(answer).resolves.toBe(false);
    expect(buffer.text()).toContain("Yes ❯ No");
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("requires --yes when no interactive terminal is available", async () => {
    const buffer = outputBuffer();
    await expect(confirmWithArrowKeys("Install?", { isTTY: false } as NodeJS.ReadStream, buffer.output)).rejects.toThrow("Re-run with --yes");
  });
});

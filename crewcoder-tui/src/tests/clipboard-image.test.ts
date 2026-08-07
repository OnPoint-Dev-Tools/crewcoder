import { describe, expect, it } from "vitest";
import { imageReadCommands } from "../tui/clipboard.js";

describe("imageReadCommands", () => {
  it("requests the image/png clipboard target on the current platform", () => {
    const commands = imageReadCommands();
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => command.mime === "image/png")).toBe(true);
  });

  it("uses MIME-typed targets on Linux so text paste is not selected", () => {
    if (process.platform !== "linux") return;
    const commands = imageReadCommands();
    expect(commands.map((command) => command.cmd)).toEqual(["wl-paste", "xclip"]);
    expect(commands[0]?.args).toContain("image/png");
  });
});

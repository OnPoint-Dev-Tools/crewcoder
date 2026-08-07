import { describe, expect, it } from "vitest";
import { browserOpenCommand } from "../core/browser-opener.js";

describe("browser opener", () => {
  it("uses the default browser opener for supported desktop platforms", () => {
    expect(browserOpenCommand("https://auth.openai.com/codex/device", "darwin")).toEqual({
      command: "open",
      args: ["https://auth.openai.com/codex/device"]
    });
    expect(browserOpenCommand("https://auth.openai.com/codex/device", "linux")).toEqual({
      command: "xdg-open",
      args: ["https://auth.openai.com/codex/device"]
    });
    expect(browserOpenCommand("https://auth.openai.com/codex/device", "win32")).toEqual({
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", "https://auth.openai.com/codex/device"]
    });
  });

  it("does not guess an opener on unsupported platforms", () => {
    expect(browserOpenCommand("https://auth.openai.com/codex/device", "aix")).toBeUndefined();
  });
});

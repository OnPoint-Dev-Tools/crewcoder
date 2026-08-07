import { describe, expect, it } from "vitest";
import { RightSidebar } from "../components/RightSidebar.js";
import { createInitialState } from "../state/tui-store.js";
import { stripAnsi } from "../tui/ansi.js";
import { crewCoderTheme } from "../theme/theme.js";

describe("remote workspace sidebar", () => {
  it("shows the SSH target with the remote workspace", () => {
    const state = createInitialState();
    state.remoteTarget = "dev@example.com";
    state.cwd = "/srv/project";

    const line = new RightSidebar(state)
      .render({ theme: crewCoderTheme, size: { width: 36, height: 18 } })
      .map(stripAnsi)
      .join("\n");

    expect(line).toContain("dev@example.com:/srv/project");
  });
});

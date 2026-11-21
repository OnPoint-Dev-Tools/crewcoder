import type { CrewTaskRecord, CrewTaskSnapshot } from "@onpoint-dev-tools/crewcoder-tui-core/state/crew-tasks";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth, MAX_SIDEBAR_WIDTH, MIN_MAIN_WIDTH, MIN_SIDEBAR_WIDTH, sidebarRows, sidebarWidth, truncateCells, wrapCells,
  type SidebarInput, type SidebarRow, type SidebarState
} from "../sidebar-model.js";

const baseState: SidebarState = {
  cwd: "/home/me/project",
  gitLabel: "main*",
  changedFiles: [],
  showFileChanges: true,
  crewWorkers: [],
  safetyPolicies: [],
  sessionId: "s1",
  crewSessionIds: []
};

function input(state: Partial<SidebarState> = {}, tasks?: CrewTaskSnapshot | null, extra: Partial<SidebarInput> = {}): SidebarInput {
  return { state: { ...baseState, ...state }, tasks: tasks === null ? undefined : tasks ?? { enabled: false, tasks: [] }, spinner: "⠋", home: "/home/me", ...extra };
}

const rowText = (row: SidebarRow): string => row.map((span) => span.text).join("");
const render = (value: SidebarInput, width = 30, height = 30): string[] => sidebarRows(value, width, height).map(rowText);
const task = (id: string, status: CrewTaskRecord["status"], extra: Partial<CrewTaskRecord> = {}): CrewTaskRecord =>
  ({ id, subject: `task ${id}`, status, sessionId: "s1", ...extra });

describe("sidebar width", () => {
  it("defaults to about a quarter of the terminal, between 20 and 36 columns", () => {
    expect(sidebarWidth(100)).toBe(26);
    expect(sidebarWidth(60)).toBe(20);
    expect(sidebarWidth(300)).toBe(36);
  });

  it("is hidden below 60 columns", () => {
    expect(sidebarWidth(59)).toBe(0);
    expect(sidebarWidth(59, 30)).toBe(0);
  });

  it("clamps a dragged width and always leaves the conversation its minimum", () => {
    expect(clampSidebarWidth(5, 200)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(500, 200)).toBe(MAX_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(500, 80)).toBe(80 - MIN_MAIN_WIDTH - 1);
    expect(sidebarWidth(120, 44)).toBe(44);
  });
});

describe("sidebar rows", () => {
  it("fills exactly the height, never exceeds the width, and anchors the workspace footer at the bottom", () => {
    for (const [width, height] of [[20, 10], [30, 30], [44, 5], [18, 2]] as const) {
      const rows = sidebarRows(input({ changedFiles: ["/home/me/project/src/a-really-long-file-name-that-wraps.ts"] }), width, height);
      expect(rows).toHaveLength(height);
      for (const row of rows) expect(stringWidth(rowText(row))).toBeLessThanOrEqual(width);
    }
    const lines = render(input(), 30, 20);
    expect(lines.at(-1)).toBe("  • CrewCoder");
    expect(lines.at(-2)).toBe("");
    expect(lines.at(-3)).toBe("  ~/project:main*");
    expect(lines.at(-4)).toBe("─".repeat(30));
  });

  it("names a remote workspace <target>:<cwd> and never shortens it with the local home", () => {
    const lines = render(input({ cwd: "/home/me/app", remoteTarget: "dev@box", gitLabel: undefined }, undefined, { home: undefined }));
    expect(lines).toContain("  dev@box:/home/me/app:local");
  });

  it("wraps a long workspace path instead of truncating it", () => {
    const lines = render(input({ cwd: "/srv/projects/an-extremely-long-workspace-folder" }, undefined, { home: undefined }), 20, 20);
    const footer = lines.slice(-6, -2).join("").replace(/\s+/g, "");
    expect(footer).toContain("/srv/projects/an-extremely-long-workspace-folder:main*");
  });

  it("lists modified files relative to the workspace, newest kept when they do not fit", () => {
    const files = Array.from({ length: 12 }, (_, index) => `/home/me/project/f${index}.ts`);
    const lines = render(input({ changedFiles: files }), 30, 20);
    expect(lines[0]).toBe("  MODIFIED FILES 12");
    // 30% of 20 rows = 6 rows: heading, four newest, "… more".
    expect(lines.slice(1, 6)).toEqual(["  ● f8.ts", "  ● f9.ts", "  ● f10.ts", "  ● f11.ts", "  … 8 more"]);
  });

  it("says when there are no changes and when the display is off", () => {
    expect(render(input())).toContain("  ✓ No file changes");
    const off = render(input({ showFileChanges: false, changedFiles: ["/x"] }));
    expect(off.slice(0, 3)).toEqual(["  MODIFIED FILES off", "  Display disabled", "  /file-changes on"]);
  });

  it("wraps long file paths under the bullet, counting wide characters as two cells", () => {
    const lines = render(input({ changedFiles: ["/home/me/project/文件夹/文件夹/文件夹.ts"] }), 20, 20);
    expect(lines[1]).toBe("  ● 文件夹/文件夹/");
    expect(lines[2]).toBe("    文件夹.ts");
  });

  it("shows agents only while a crew is live, running names in the heading", () => {
    const workers = [
      { name: "reviewer", status: "pending" as const },
      { name: "builder", status: "running" as const },
      { name: "scout", status: "completed" as const }
    ];
    const lines = render(input({ crewWorkers: workers }), 30, 40);
    const start = lines.indexOf("  AGENTS: builder");
    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start + 1, start + 4)).toEqual(["  ⠋ builder running", "  □ reviewer queued", "  ✓ scout completed"]);
    const done = render(input({ crewWorkers: workers.map((worker) => ({ ...worker, status: "completed" as const })) }), 30, 40);
    expect(done.some((line) => line.includes("AGENTS"))).toBe(false);
  });

  it("puts a SAFETY status at the top when extension policies apply", () => {
    const policy = { extensionId: "e", policyId: "p", title: "t", tools: [], paths: [], commands: [] };
    const lines = render(input({ safetyPolicies: [{ ...policy, action: "block" }, { ...policy, action: "review" }] }), 40);
    expect(lines.slice(0, 2)).toEqual(["  STATUS 1", "  SAFETY  2 · 1 block · 1 review"]);
  });
});

describe("crew tasks section", () => {
  it("is absent while tasks are off", () => {
    expect(render(input({}, { enabled: false, tasks: [task("1", "pending")] })).some((line) => line.includes("CREW TASKS"))).toBe(false);
  });

  it("shows this session's progress, active form, blocked and done markers, active first", () => {
    const tasks = [
      task("1", "completed", { updatedAt: 3 }),
      task("2", "in_progress", { activeForm: "Writing tests" }),
      task("3", "pending", { blockedBy: ["2"] }),
      task("4", "pending", { sessionId: "elsewhere" })
    ];
    const rows = sidebarRows(input({}, { enabled: true, tasks }), 34, 30);
    const lines = rows.map(rowText);
    const start = lines.indexOf("  CREW TASKS — 1/3 completed");
    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start + 1, start + 4)).toEqual(["  ◉ 2. Writing tests", "  ! 3. task 3", "  ✓ 1. task 1"]);
    const done = rows[start + 3]?.at(-1);
    expect(done).toMatchObject({ text: "task 1", strike: true });
    expect(rows[start + 1]?.at(-1)).toMatchObject({ bold: true, strike: false });
  });

  it("includes tasks crew workers created in their own sessions", () => {
    const tasks = [task("1", "pending"), task("2", "in_progress", { sessionId: "worker-s" }), task("3", "pending", { sessionId: "elsewhere" })];
    const lines = render(input({ crewSessionIds: ["worker-s"] }, { enabled: true, tasks }), 34);
    expect(lines).toContain("  CREW TASKS — 0/2 completed");
    expect(lines).toContain("  ◉ 2. task 2");
    expect(lines.join("\n")).not.toContain("task 3");
  });

  it("uses a compact heading when narrow and says when the session has no tasks", () => {
    const lines = render(input({ sessionId: "new" }, { enabled: true, tasks: [task("1", "pending")] }), 24);
    expect(lines).toContain("  CREW TASKS 0/0");
    expect(lines).toContain("  No tasks for this");
    expect(lines).toContain("  session");
  });

  it("explains that tasks are not read for SSH workspaces", () => {
    expect(render(input({}, null))).toContain("  Not shown for SSH");
    expect(render(input({}, null), 40)).toContain("  Not shown for SSH workspaces");
  });

  it("wraps long task text under its label and counts what does not fit", () => {
    const tasks = Array.from({ length: 6 }, (_, index) => task(String(index + 1), "pending", { subject: `a fairly long task subject number ${index + 1}` }));
    const lines = render(input({}, { enabled: true, tasks }), 24, 16);
    const start = lines.findIndex((line) => line.startsWith("  CREW TASKS"));
    const section = lines.slice(start, -4).filter(Boolean);
    expect(section.at(-1)).toMatch(/^ {2}… \d more$/);
    expect(section[2]).toMatch(/^ {7}\S/);
  });
});

describe("cell helpers", () => {
  it("wraps by words and splits words longer than a row", () => {
    expect(wrapCells("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrapCells("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapCells("", 4)).toEqual([""]);
  });

  it("truncates by cells", () => {
    expect(truncateCells("abcdef", 4)).toBe("abc…");
    expect(truncateCells("文件夹", 4)).toBe("文…");
    expect(truncateCells("abc", 3)).toBe("abc");
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePlugin } from "../tools/validate-plugin.js";

describe("validatePlugin", () => {
  it("validates a basic static panel plugin", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-plugin-"));
    fs.writeFileSync(path.join(dir, "panel.html"), "<html></html>");
    fs.writeFileSync(path.join(dir, "crewcode.plugin.json"), JSON.stringify({
      id: "test-plugin",
      name: "Test Plugin",
      version: "0.1.0",
      crewcode: { apiVersion: "0.1" },
      permissions: ["workspace:read"],
      contributes: {
        tabs: [{ id: "main", title: "Main", entry: "panel.html" }]
      }
    }));

    const result = validatePlugin(dir);
    expect(result.ok).toBe(true);
  });

  it("rejects forbidden electron API usage", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-plugin-"));
    fs.writeFileSync(path.join(dir, "panel.html"), "<script>window.electronAPI</script>");
    fs.writeFileSync(path.join(dir, "crewcode.plugin.json"), JSON.stringify({
      id: "bad-plugin",
      name: "Bad Plugin",
      version: "0.1.0",
      crewcode: { apiVersion: "0.1" },
      permissions: [],
      contributes: {
        tabs: [{ id: "main", title: "Main", entry: "panel.html" }]
      }
    }));

    const result = validatePlugin(dir);
    expect(result.ok).toBe(false);
  });
});

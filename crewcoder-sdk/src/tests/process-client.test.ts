import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCrewCoderProcess } from "../index.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "acp-agent.mjs");

describe("CrewCoderProcess", () => {
  it("creates an ACP subprocess session and streams updates", async () => {
    const updates: string[] = [];
    const client = await createCrewCoderProcess({ command: process.execPath, args: [fixture] });
    client.subscribe((event) => { updates.push(JSON.stringify(event)); });
    try {
      const result = await client.prompt("hello");
      expect(client.sessionId).toBe("session_fixture");
      expect(result).toMatchObject({ stopReason: "end_turn" });
      expect(updates.join("\n")).toContain("fixture response");
    } finally {
      client.dispose();
    }
  });

  it("rejects empty prompts and use after disposal", async () => {
    const client = await createCrewCoderProcess({ command: process.execPath, args: [fixture] });
    await expect(client.prompt(" ")).rejects.toThrow(/non-empty/);
    client.dispose();
    await expect(client.prompt("hello")).rejects.toThrow(/disposed/);
  });
});

import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../core/events.js";
import { createExtensionUiBridge } from "../core/extension-ui-bridge.js";

describe("extension UI bridge", () => {
  it("bounds declarative component payloads before emitting them", async () => {
    const events: AgentEvent[] = [];
    const bridge = createExtensionUiBridge({ hasUI: true, emit: (event) => { events.push(event); } });
    const ui = bridge.uiFor("demo");

    const pending = ui.component("Large table", {
      kind: "table",
      columns: Array.from({ length: 12 }, (_, index) => ({ key: `col${index}`, label: `Column ${index}` })),
      rows: Array.from({ length: 120 }, (_, index) => ({ col0: "x".repeat(1200), col1: index, extra: "ignored" }))
    }, { actions: Array.from({ length: 25 }, (_, index) => ({ id: `action-${index}`, label: `Action ${index}` })) });

    const request = events.find((event) => event.type === "extension_ui_request");
    expect(request).toBeDefined();
    expect(request?.component).toMatchObject({ kind: "table" });
    if (request?.component?.kind !== "table") throw new Error("expected table component");
    expect(request.component.columns).toHaveLength(8);
    expect(request.component.rows).toHaveLength(100);
    expect(String(request.component.rows[0]?.col0 ?? "")).toHaveLength(1000);
    expect(request.component.rows[0]).not.toHaveProperty("extra");
    expect(request.actions).toHaveLength(20);

    bridge.resolveResponse(request.requestId, "action-0");
    await expect(pending).resolves.toBe("action-0");
  });
});

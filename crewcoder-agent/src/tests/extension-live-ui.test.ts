import { describe, expect, it } from "vitest";
import {
  checkLiveUiMatchRules,
  evaluateLiveUiGate,
  liveUiContributionsFromManifest,
  SUPPORTED_LIVE_UI_SURFACES
} from "../extensions/extension-live-ui.js";
import type { CrewCoderExtensionLiveUiContribution, LoadedCrewCoderExtension } from "../extensions/types.js";

function contribution(overrides: Partial<CrewCoderExtensionLiveUiContribution> = {}): CrewCoderExtensionLiveUiContribution {
  return {
    id: "review-panel",
    title: "Review Panel",
    experimental: true,
    entry: "ui/review-panel.ts",
    target: { surface: "modal", slot: "extension-ui" },
    match: { eventTypes: ["extension_ui_request"] },
    permissions: { ui: ["render", "input", "focus"], commands: ["ui_response"] },
    ...overrides
  } as CrewCoderExtensionLiveUiContribution;
}

const fullyTrusted = { enabled: true, trusted: true, allowLiveUi: true } as const;

describe("evaluateLiveUiGate", () => {
  it("allows a fully-trusted, well-formed contribution", () => {
    const gate = evaluateLiveUiGate(contribution(), fullyTrusted);
    expect(gate.allowed).toBe(true);
    expect(gate.blockedReasons).toEqual([]);
  });

  it("denies by default when the config flag is off", () => {
    const gate = evaluateLiveUiGate(contribution(), { enabled: true, trusted: true, allowLiveUi: false });
    expect(gate.allowed).toBe(false);
    expect(gate.blockedReasons.some((reason) => reason.includes("allowExtensionLiveUi"))).toBe(true);
  });

  it("denies when the extension is disabled or untrusted", () => {
    const gate = evaluateLiveUiGate(contribution(), { enabled: false, trusted: false, allowLiveUi: true });
    expect(gate.allowed).toBe(false);
    expect(gate.blockedReasons).toContain("extension is disabled");
    expect(gate.blockedReasons.some((reason) => reason.includes("not trusted"))).toBe(true);
  });

  it("requires the experimental marker", () => {
    const gate = evaluateLiveUiGate(contribution({ experimental: false as unknown as true }), fullyTrusted);
    expect(gate.allowed).toBe(false);
    expect(gate.blockedReasons).toContain("contribution is missing experimental: true");
  });

  it("rejects unsupported surfaces", () => {
    const gate = evaluateLiveUiGate(contribution({ target: { surface: "sidebar" as never } }), fullyTrusted);
    expect(gate.allowed).toBe(false);
    expect(gate.blockedReasons.some((reason) => reason.startsWith("unsupported surface"))).toBe(true);
  });

  it("requires the ui:render permission and rejects unsupported permissions", () => {
    const gate = evaluateLiveUiGate(
      contribution({ permissions: { ui: ["input"], clipboard: "admin" as never, network: { allowedHosts: "not-an-array" as never }, events: ["bad-event"] as never } }),
      fullyTrusted
    );
    expect(gate.allowed).toBe(false);
    expect(gate.blockedReasons.some((reason) => reason.includes("\"render\""))).toBe(true);
    expect(gate.blockedReasons.some((reason) => reason.includes("clipboard"))).toBe(true);
    expect(gate.blockedReasons.some((reason) => reason.includes("network"))).toBe(true);
    expect(gate.blockedReasons.some((reason) => reason.includes("events"))).toBe(true);
  });

  it("exposes the host-supported surfaces", () => {
    expect(SUPPORTED_LIVE_UI_SURFACES).toEqual(["modal", "transcript", "status"]);
  });
});

describe("liveUiContributionsFromManifest", () => {
  it("summarizes contributions with gate status", () => {
    const extension: LoadedCrewCoderExtension = {
      dir: "/tmp/ext",
      warnings: [],
      manifest: {
        id: "review-pack",
        name: "Review Pack",
        version: "0.1.0",
        crewcoder: { apiVersion: "0.1" },
        contributes: { liveUi: [contribution(), contribution({ id: "status-panel", target: { surface: "status" }, experimental: false as unknown as true })] }
      }
    };
    const summaries = liveUiContributionsFromManifest(extension, fullyTrusted);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({ extensionId: "review-pack", id: "review-panel", surface: "modal", allowed: true });
    expect(summaries[1]).toMatchObject({ id: "status-panel", allowed: false });
    expect(summaries[1]?.blockedReasons).toContain("contribution is missing experimental: true");
  });
});

describe("checkLiveUiMatchRules", () => {
  it("passes when all match fields match the payload", () => {
    const reasons = checkLiveUiMatchRules(
      contribution({
        match: { eventTypes: ["extension_ui_request"], uiKinds: ["component"] }
      }),
      { eventType: "extension_ui_request", uiKind: "component" }
    );
    expect(reasons).toEqual([]);
  });

  it("reports mismatched eventTypes", () => {
    const reasons = checkLiveUiMatchRules(
      contribution({ match: { eventTypes: ["extension_ui_request"] } }),
      { eventType: "tool_execution_end" }
    );
    expect(reasons.some((r) => r.includes("match.eventTypes"))).toBe(true);
  });

  it("reports missing payload field when match field is non-empty", () => {
    const reasons = checkLiveUiMatchRules(
      contribution({ match: { eventTypes: ["extension_ui_request"], toolNames: ["write"] } }),
      { eventType: "extension_ui_request" }
    );
    expect(reasons.some((r) => r.includes("match.toolNames"))).toBe(true);
  });

  it("skips empty/absent match arrays", () => {
    const reasons = checkLiveUiMatchRules(
      contribution({ match: { eventTypes: [] } }),
      {}
    );
    expect(reasons).toEqual([]);
  });

  it("checks activation events against payload", () => {
    const reasons = checkLiveUiMatchRules(
      contribution({
        activation: { events: ["extension_ui_request"] },
        match: { eventTypes: ["extension_ui_request"] }
      }),
      { eventType: "tool_execution_end" }
    );
    expect(reasons.some((r) => r.includes("activation.event"))).toBe(true);
  });

  it("checks activation modes against payload", () => {
    const reasons = checkLiveUiMatchRules(
      contribution({
        activation: { modes: ["tui"] },
        match: { eventTypes: ["extension_ui_request"] }
      }),
      { eventType: "extension_ui_request" }
    );
    expect(reasons.some((r) => r.includes("activation.mode"))).toBe(true);
  });

  it("checks activation commands against payload", () => {
    const reasons = checkLiveUiMatchRules(
      contribution({
        activation: { commands: ["ext.review.show"] },
        match: { eventTypes: ["extension_ui_request"] }
      }),
      { eventType: "extension_ui_request", commandName: "ext.review.show" }
    );
    expect(reasons).toEqual([]);
  });

  it("checks all match dimensions", () => {
    const reasons = checkLiveUiMatchRules(
      contribution({
        match: {
          eventTypes: ["extension_ui_request"],
          toolNames: ["write"],
          extensionIds: ["test-pack"],
          toolIds: ["test-tool"],
          renderers: ["test-renderer"],
          uiKinds: ["component"],
          componentKinds: ["markdown"]
        }
      }),
      {
        eventType: "extension_ui_request",
        toolName: "write",
        extensionId: "test-pack",
        toolId: "test-tool",
        renderer: "test-renderer",
        uiKind: "component",
        componentKind: "markdown"
      }
    );
    expect(reasons).toEqual([]);
  });

  it("reports missing match object", () => {
    const reasons = checkLiveUiMatchRules(
      contribution({ match: undefined as unknown as NonNullable<CrewCoderExtensionLiveUiContribution["match"]> }),
      {}
    );
    expect(reasons).toContain("contribution is missing match rules");
  });
});

describe("evaluateLiveUiGate with payload", () => {
  it("blocks when payload does not match activation rules", () => {
    const gate = evaluateLiveUiGate(
      contribution({
        activation: { events: ["extension_ui_request"] },
        match: { eventTypes: ["extension_ui_request"] }
      }),
      { ...fullyTrusted, payload: { eventType: "tool_execution_end" } }
    );
    expect(gate.allowed).toBe(false);
    expect(gate.blockedReasons.some((r) => r.includes("activation.event"))).toBe(true);
  });

  it("blocks when payload does not match match rules", () => {
    const gate = evaluateLiveUiGate(
      contribution({ match: { eventTypes: ["extension_ui_request"] } }),
      { ...fullyTrusted, payload: { eventType: "tool_execution_end" } }
    );
    expect(gate.allowed).toBe(false);
    expect(gate.blockedReasons.some((r) => r.includes("match.eventTypes"))).toBe(true);
  });

  it("allows when all gates pass including payload match", () => {
    const gate = evaluateLiveUiGate(
      contribution({ match: { eventTypes: ["extension_ui_request"], uiKinds: ["component"] } }),
      { ...fullyTrusted, payload: { eventType: "extension_ui_request", uiKind: "component" } }
    );
    expect(gate.allowed).toBe(true);
  });

  it("combines static and payload gate failures", () => {
    const gate = evaluateLiveUiGate(
      contribution({
        experimental: false as unknown as true,
        match: { eventTypes: ["extension_ui_request"] }
      }),
      { ...fullyTrusted, payload: { eventType: "tool_execution_end" } }
    );
    expect(gate.allowed).toBe(false);
    expect(gate.blockedReasons.some((r) => r.includes("experimental"))).toBe(true);
    expect(gate.blockedReasons.some((r) => r.includes("match.eventTypes"))).toBe(true);
  });
});

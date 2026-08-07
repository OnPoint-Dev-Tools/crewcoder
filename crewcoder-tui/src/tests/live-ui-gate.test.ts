import { describe, expect, it } from "vitest";
import {
  buildLiveUiHostGrant,
  buildLiveUiProps,
  evaluateTuiLiveUiGate,
  grantLiveUiPermissions,
  matchesTuiLiveUiContribution,
  prepareLiveUiSpawn,
  type TuiLiveUiContribution,
  type TuiLiveUiEvent,
  type TuiLiveUiGateContext
} from "../bridge/live-ui-gate.js";

function contribution(overrides: Partial<TuiLiveUiContribution> = {}): TuiLiveUiContribution {
  return {
    id: "review-panel",
    title: "Review Panel",
    entry: "ui/review-panel.js",
    experimental: true,
    target: { surface: "modal", slot: "extension-ui" },
    permissions: { ui: ["render", "input", "focus"], commands: ["ui_response"], storage: "session" },
    ...overrides
  };
}

const trusted: TuiLiveUiGateContext = { enabled: true, trusted: true, allowLiveUi: true };

describe("evaluateTuiLiveUiGate", () => {
  it("allows a fully-trusted contribution", () => {
    expect(evaluateTuiLiveUiGate(contribution(), trusted)).toEqual({ allowed: true, blockedReasons: [] });
  });

  it("denies when config, trust, or enablement gates fail", () => {
    const result = evaluateTuiLiveUiGate(contribution(), { enabled: false, trusted: false, allowLiveUi: false });
    expect(result.allowed).toBe(false);
    expect(result.blockedReasons).toContain("extension is disabled");
    expect(result.blockedReasons).toContain("extension is not trusted");
    expect(result.blockedReasons).toContain("allowExtensionLiveUi is off");
  });

  it("requires ui:render and a supported surface", () => {
    const noRender = evaluateTuiLiveUiGate(contribution({ permissions: { ui: ["input"] } }), trusted);
    expect(noRender.allowed).toBe(false);
    const badSurface = evaluateTuiLiveUiGate(contribution({ target: { surface: "sidebar" as never } }), trusted);
    expect(badSurface.blockedReasons.some((r) => r.startsWith("unsupported surface"))).toBe(true);
  });
});

describe("grantLiveUiPermissions", () => {
  it("intersects requested permissions with host support (deny-by-default)", () => {
    const granted = grantLiveUiPermissions(
      { ui: ["render", "input", "focus"], commands: ["ui_response", "ext.foo" as never], clipboard: "write", network: { allowedHosts: ["x"] }, storage: "session" },
      trusted
    );
    expect(granted.ui).toEqual(["render", "input", "focus"]);
    expect(granted.commands).toEqual(["ui_response"]);
    expect(granted.storage).toBe("session");
    expect(granted.clipboard).toBeUndefined();
    expect(granted.network).toBeUndefined();
  });

  it("never grants more than requested", () => {
    const granted = grantLiveUiPermissions({ ui: ["render"] }, trusted);
    expect(granted.ui).toEqual(["render"]);
    expect(granted.commands).toBeUndefined();
    expect(granted.storage).toBeUndefined();
  });
});

describe("buildLiveUiProps", () => {
  it("maps a contribution + event into immutable props", () => {
    const props = buildLiveUiProps("review-pack", contribution(), { type: "extension_ui_request", requestId: "r1", uiKind: "component", title: "T" });
    expect(props).toMatchObject({
      extensionId: "review-pack",
      contributionId: "review-panel",
      surface: "modal",
      slot: "extension-ui",
      event: { type: "extension_ui_request", requestId: "r1", uiKind: "component", title: "T" }
    });
  });
});

describe("prepareLiveUiSpawn", () => {
  it("returns props + granted host when allowed", () => {
    const plan = prepareLiveUiSpawn("review-pack", contribution(), { type: "extension_ui_request" }, trusted);
    expect(plan.allowed).toBe(true);
    if (!plan.allowed) throw new Error("expected allowed plan");
    expect(plan.host.transport).toBe("worker-postmessage");
    expect(plan.host.permissions.ui).toContain("render");
    expect(plan.props.contributionId).toBe("review-panel");
  });

  it("returns blocked reasons and no spawn inputs when denied", () => {
    const plan = prepareLiveUiSpawn("review-pack", contribution(), { type: "x" }, { ...trusted, allowLiveUi: false });
    expect(plan.allowed).toBe(false);
    expect(plan.blockedReasons.length).toBeGreaterThan(0);
  });

  it("stamps the negotiated limits on the granted host", () => {
    const host = buildLiveUiHostGrant(contribution(), trusted, { maxRenderLines: 10, maxLineLength: 20, maxPayloadBytes: 30 });
    expect(host.limits).toEqual({ maxRenderLines: 10, maxLineLength: 20, maxPayloadBytes: 30 });
  });
});

describe("matchesTuiLiveUiContribution", () => {
  const event = (overrides: Partial<TuiLiveUiEvent> = {}): TuiLiveUiEvent => ({
    type: "extension_ui_request",
    requestId: "r1",
    uiKind: "component",
    extensionId: "review-pack",
    title: "Review",
    ...overrides
  });

  it("matches when no rules are declared", () => {
    expect(matchesTuiLiveUiContribution(contribution(), event())).toBe(true);
  });

  it("matches when activation.events includes the event type", () => {
    const c = contribution({ activation: { events: ["extension_ui_request"] } });
    expect(matchesTuiLiveUiContribution(c, event())).toBe(true);
    expect(matchesTuiLiveUiContribution(c, event({ type: "other" }))).toBe(false);
  });

  it("matches eventTypes, extensionIds, uiKinds, and componentKinds", () => {
    const c = contribution({
      match: {
        eventTypes: ["extension_ui_request"],
        extensionIds: ["review-pack"],
        uiKinds: ["component"],
        componentKinds: ["table"]
      }
    });
    expect(matchesTuiLiveUiContribution(c, event({ component: { kind: "table", rows: [] } }))).toBe(true);
    expect(matchesTuiLiveUiContribution(c, event({ type: "tool_execution_start" }))).toBe(false);
    expect(matchesTuiLiveUiContribution(c, event({ extensionId: "other-pack" }))).toBe(false);
    expect(matchesTuiLiveUiContribution(c, event({ uiKind: "confirm" }))).toBe(false);
    expect(matchesTuiLiveUiContribution(c, event({ component: { kind: "markdown", text: "hi" } }))).toBe(false);
  });

  it("matches toolNames and toolIds for inline tool-block renderers", () => {
    const c = contribution({
      target: { surface: "transcript" },
      match: { toolNames: ["bash"], toolIds: ["call-1"] }
    });
    expect(matchesTuiLiveUiContribution(c, event({ type: "tool_execution_end", toolName: "bash", toolCallId: "call-1" }))).toBe(true);
    expect(matchesTuiLiveUiContribution(c, event({ type: "tool_execution_end", toolName: "bash" }))).toBe(false);
    expect(matchesTuiLiveUiContribution(c, event({ type: "tool_execution_end", toolName: "edit", toolCallId: "call-1" }))).toBe(false);
  });
});

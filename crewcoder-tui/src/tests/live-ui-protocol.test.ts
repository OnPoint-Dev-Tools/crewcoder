import { describe, expect, it } from "vitest";
import {
  canSendLiveUiInput,
  clampLiveUiFrame,
  isLiveUiHostCommandAllowed,
  isLiveUiRenderProducing,
  isReservedLiveUiInput,
  parseLiveUiChildMessage,
  parseLiveUiHostMessage,
  type CrewCoderLiveUiLimits,
  type CrewCoderLiveUiPermissions,
  type CrewCoderLiveUiProps,
  type LiveUiFrame
} from "../bridge/live-ui-protocol.js";

const sampleProps: CrewCoderLiveUiProps = {
  extensionId: "review-pack",
  contributionId: "review-panel",
  surface: "modal",
  event: { type: "extension_ui_request", uiKind: "component" }
};

const limits: CrewCoderLiveUiLimits = { maxRenderLines: 3, maxLineLength: 5, maxPayloadBytes: 1000 };

function makeFrame(overrides: Partial<LiveUiFrame> = {}): LiveUiFrame {
  return {
    width: 5,
    height: 3,
    lines: [
      [{ text: "a" }, { text: "b" }, { text: "c" }],
      [{ text: "d" }, { text: "e" }],
      [{ text: "f" }]
    ],
    ...overrides
  };
}

describe("live UI frame clamping", () => {
  it("caps the number of rendered lines", () => {
    const frame = makeFrame({
      height: 5,
      lines: [
        [{ text: "a" }], [{ text: "b" }], [{ text: "c" }],
        [{ text: "d" }], [{ text: "e" }]
      ]
    });
    const result = clampLiveUiFrame(frame, limits);
    expect(result.lines).toHaveLength(3);
    expect(result.height).toBe(3);
  });

  it("caps cells per line to the negotiated limit", () => {
    const frame = makeFrame({
      width: 10,
      lines: [[
        { text: "a" }, { text: "b" }, { text: "c" }, { text: "d" },
        { text: "e" }, { text: "f" }, { text: "g" }
      ]]
    });
    const result = clampLiveUiFrame(frame, limits);
    expect(result.lines[0]).toHaveLength(5);
    expect(result.width).toBe(5);
  });

  it("truncates over-long cell text", () => {
    const frame = makeFrame({
      lines: [[{ text: "a".repeat(300) }, { text: "b" }]]
    });
    const result = clampLiveUiFrame(frame, limits);
    expect(result.lines[0][0].text.length).toBeLessThanOrEqual(200);
  });

  it("stops once the payload byte budget is exhausted", () => {
    const tight: CrewCoderLiveUiLimits = { maxRenderLines: 10, maxLineLength: 10, maxPayloadBytes: 5 };
    const frame = makeFrame({
      lines: [
        [{ text: "aaa" }],
        [{ text: "bbb" }],
        [{ text: "ccc" }]
      ]
    });
    const result = clampLiveUiFrame(frame, tight);
    expect(result.lines.length).toBeLessThan(3);
  });

  it("preserves only the first line when all cells exceed the byte budget", () => {
    const tight: CrewCoderLiveUiLimits = { maxRenderLines: 10, maxLineLength: 10, maxPayloadBytes: 2 };
    const frame = makeFrame({
      lines: [
        [{ text: "x" }],
        [{ text: "yy" }],
        [{ text: "zzz" }]
      ]
    });
    const result = clampLiveUiFrame(frame, tight);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toEqual([{ text: "x" }]);
  });

  it("clamps actions count and label length", () => {
    const frame = makeFrame({
      actions: [
        { id: "a", label: "L".repeat(100) },
        { id: "b", label: "short" }
      ]
    });
    const result = clampLiveUiFrame(frame, limits);
    expect(result.actions).toBeDefined();
    expect(result.actions![0].label.length).toBeLessThanOrEqual(60);
    expect(result.actions![1]).toEqual({ id: "b", label: "short" });
  });

  it("preserves the frame width/height declared by limits after clamping", () => {
    const frame = makeFrame({ width: 20, height: 10 });
    const result = clampLiveUiFrame(frame, limits);
    expect(result.width).toBe(5);
    expect(result.height).toBe(3);
  });
});

describe("live UI capability checks", () => {
  it("allows notify and repaint unconditionally", () => {
    const none: CrewCoderLiveUiPermissions = {};
    expect(isLiveUiHostCommandAllowed({ type: "notify", message: "hi" }, none)).toBe(true);
    expect(isLiveUiHostCommandAllowed({ type: "request_repaint" }, none)).toBe(true);
  });

  it("gates resolve_ui_request behind the ui_response command grant", () => {
    expect(isLiveUiHostCommandAllowed({ type: "resolve_ui_request", requestId: "r", value: true }, {})).toBe(false);
    expect(
      isLiveUiHostCommandAllowed({ type: "resolve_ui_request", requestId: "r", value: true }, { commands: ["ui_response"] })
    ).toBe(true);
  });

  it("gates session state behind the storage grant", () => {
    expect(isLiveUiHostCommandAllowed({ type: "write_session_state", key: "k", value: 1 }, {})).toBe(false);
    expect(isLiveUiHostCommandAllowed({ type: "read_session_state", requestId: "r", key: "k" }, { storage: "session" })).toBe(true);
  });

  it("gates input on the ui input grant", () => {
    expect(canSendLiveUiInput({ ui: ["render"] })).toBe(false);
    expect(canSendLiveUiInput({ ui: ["render", "input"] })).toBe(true);
  });

  it("reserves global TUI shortcuts from live UI forwarding", () => {
    expect(isReservedLiveUiInput({ name: "escape" })).toBe(true);
    expect(isReservedLiveUiInput({ name: "p", ctrl: true })).toBe(true);
    expect(isReservedLiveUiInput({ name: "p" })).toBe(false);
  });
});

describe("live UI message parsing", () => {
  it("parses valid host messages and rejects malformed ones", () => {
    const focusInfo = { instanceId: "i", extensionId: "e", contributionId: "c", title: "e/c" };
    expect(parseLiveUiHostMessage({ type: "mount", width: 80, height: 24 })).toEqual({ type: "mount", width: 80, height: 24 });
    expect(parseLiveUiHostMessage({ type: "resize", width: 80, height: 24 })).toEqual({ type: "resize", width: 80, height: 24 });
    expect(parseLiveUiHostMessage({ type: "update", props: sampleProps })).toEqual({ type: "update", props: sampleProps });
    expect(parseLiveUiHostMessage({ type: "focus", focusInfo })).toEqual({ type: "focus", focusInfo });
    expect(parseLiveUiHostMessage({ type: "blur", focusInfo })).toEqual({ type: "blur", focusInfo });
    expect(parseLiveUiHostMessage({ type: "mount", width: "80" })).toBeUndefined();
    expect(parseLiveUiHostMessage({ type: "update", props: "nope" })).toBeUndefined();
    expect(parseLiveUiHostMessage({ type: "render", width: 80, height: 24 })).toBeUndefined();
    expect(parseLiveUiHostMessage({ type: "dispose" })).toEqual({ type: "dispose" });
    expect(parseLiveUiHostMessage("nope")).toBeUndefined();
  });

  it("flags render-producing lifecycle messages", () => {
    expect(isLiveUiRenderProducing({ type: "mount", width: 1, height: 1 })).toBe(true);
    expect(isLiveUiRenderProducing({ type: "resize", width: 1, height: 1 })).toBe(true);
    expect(isLiveUiRenderProducing({ type: "update", props: sampleProps })).toBe(true);
    expect(isLiveUiRenderProducing({ type: "dispose" })).toBe(false);
    expect(isLiveUiRenderProducing({ type: "input", event: { name: "return" } })).toBe(false);
  });

  it("parses valid child frames and rejects malformed ones", () => {
    const frame = makeFrame();
    expect(parseLiveUiChildMessage({ type: "rendered", frame })).toEqual({ type: "rendered", frame });
    expect(parseLiveUiChildMessage({ type: "rendered", frame: { lines: "nope" } })).toBeUndefined();
    expect(parseLiveUiChildMessage({ type: "rendered", frame: { width: 1, height: 1, lines: [[{ notText: true }]] } })).toBeUndefined();
    expect(parseLiveUiChildMessage({ type: "handled_input", handled: true })).toEqual({ type: "handled_input", handled: true });
    expect(
      parseLiveUiChildMessage({ type: "host_command", command: { type: "notify", message: "hi", level: "warning" } })
    ).toEqual({ type: "host_command", command: { type: "notify", message: "hi", level: "warning" } });
    expect(parseLiveUiChildMessage({ type: "host_command", command: { type: "bogus" } })).toBeUndefined();
  });

  it("parses a frame with actions", () => {
    const frame = makeFrame({ actions: [{ id: "ok", label: "OK" }] });
    const result = parseLiveUiChildMessage({ type: "rendered", frame });
    expect(result).toEqual({ type: "rendered", frame });
  });

  it("rejects frames with malformed actions", () => {
    const badActions = [{ id: 1, label: "nope" }];
    const frame = { width: 1, height: 1, lines: [[{ text: "x" }]], actions: badActions };
    expect(parseLiveUiChildMessage({ type: "rendered", frame })).toBeUndefined();
  });

  it("rejects frames missing width or height", () => {
    expect(parseLiveUiChildMessage({ type: "rendered", frame: { lines: [[{ text: "x" }]] } })).toBeUndefined();
    expect(parseLiveUiChildMessage({ type: "rendered", frame: { width: 1, lines: [[{ text: "x" }]] } })).toBeUndefined();
  });

  it("parses rendered messages with an optional scrollHeight", () => {
    const frame = makeFrame();
    expect(parseLiveUiChildMessage({ type: "rendered", frame, scrollHeight: 24 })).toEqual({ type: "rendered", frame, scrollHeight: 24 });
    expect(parseLiveUiChildMessage({ type: "rendered", frame })).toEqual({ type: "rendered", frame });
  });

  it("parses viewport host messages", () => {
    expect(parseLiveUiHostMessage({ type: "viewport", scrollOffset: 5, viewportHeight: 10 })).toEqual({ type: "viewport", scrollOffset: 5, viewportHeight: 10 });
    expect(parseLiveUiHostMessage({ type: "viewport", scrollOffset: "5", viewportHeight: 10 })).toBeUndefined();
    expect(isLiveUiRenderProducing({ type: "viewport", scrollOffset: 0, viewportHeight: 10 })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { LiveUiTrustGate } from "../bridge/live-ui-trust-gate.js";
import { LiveUiHost } from "../bridge/live-ui-host.js";
import type { LiveUiSpawnOptions, LiveUiWorkerLike, LiveUiWorkerSpec } from "../bridge/live-ui-host.js";
import type { CrewCoderLiveUiHost, CrewCoderLiveUiProps } from "../bridge/live-ui-protocol.js";

function props(): CrewCoderLiveUiProps {
  return { extensionId: "review-pack", contributionId: "review-panel", surface: "modal", event: { type: "x" } };
}

function host(): CrewCoderLiveUiHost {
  return {
    protocolVersion: "0.1",
    transport: "worker-postmessage",
    permissions: { ui: ["render", "input"] },
    limits: { maxRenderLines: 50, maxLineLength: 200, maxPayloadBytes: 64 * 1024 }
  };
}

class FakeWorker implements LiveUiWorkerLike {
  posted: unknown[] = [];
  terminated = 0;
  private listeners = new Map<string, ((value: unknown) => void)[]>();
  postMessage(value: unknown): void { this.posted.push(value); }
  on(event: string, listener: (value: unknown) => void): this {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
    return this;
  }
  terminate(): Promise<number> { this.terminated += 1; return Promise.resolve(0); }
  emit(event: string, value?: unknown): void { for (const listener of this.listeners.get(event) ?? []) listener(value); }
}

describe("LiveUiTrustGate", () => {
  it("denies spawn when live UI is not allowed", () => {
    const gate = new LiveUiTrustGate();
    gate.allowed = false;
    const spawned = gate.spawnHost({ entryPath: "/x.js", props: props(), host: host() });
    expect(spawned).toBeNull();
    expect(gate.isTrusted("review-panel")).toBe(false);
  });

  it("spawns, tracks, and exposes a focused host", () => {
    const gate = new LiveUiTrustGate();
    gate.allowed = true;
    const worker = new FakeWorker();
    const spawned = gate.spawnHost({ entryPath: "/x.js", props: props(), host: host() }, {}, () => worker);
    expect(spawned).toBeInstanceOf(LiveUiHost);
    expect(gate.getHost("review-panel")).toBe(spawned);
    expect(gate.isTrusted("review-panel")).toBe(true);
  });

  it("focuses one host at a time and blurs the previous host", () => {
    const gate = new LiveUiTrustGate();
    gate.allowed = true;
    const workerA = new FakeWorker();
    const workerB = new FakeWorker();
    const hostA = gate.spawnHost(
      { entryPath: "/a.js", props: { ...props(), contributionId: "panel-a" }, host: host() },
      {},
      () => workerA
    )!;
    const hostB = gate.spawnHost(
      { entryPath: "/b.js", props: { ...props(), contributionId: "panel-b" }, host: host() },
      {},
      () => workerB
    )!;

    workerA.emit("message", {
      type: "ready",
      instance: { instanceId: "a", extensionId: "review-pack", contributionId: "panel-a", surface: "modal", canReceiveInput: true, focusInfo: { instanceId: "a", extensionId: "review-pack", contributionId: "panel-a", title: "a" } }
    });
    workerB.emit("message", {
      type: "ready",
      instance: { instanceId: "b", extensionId: "review-pack", contributionId: "panel-b", surface: "modal", canReceiveInput: true, focusInfo: { instanceId: "b", extensionId: "review-pack", contributionId: "panel-b", title: "b" } }
    });

    expect(gate.focusHost("panel-a")).toBe(true);
    expect(gate.getFocusedHost()).toBe(hostA);
    expect(gate.focusHost("panel-b")).toBe(true);
    expect(gate.getFocusedHost()).toBe(hostB);

    const postedA = workerA.posted as Array<{ type?: string }>;
    const postedB = workerB.posted as Array<{ type?: string }>;
    expect(postedA.some((m) => m.type === "blur")).toBe(true);
    expect(postedB.some((m) => m.type === "focus")).toBe(true);
  });

  it("blurCurrent clears the focused host", () => {
    const gate = new LiveUiTrustGate();
    gate.allowed = true;
    const worker = new FakeWorker();
    gate.spawnHost({ entryPath: "/x.js", props: props(), host: host() }, {}, () => worker);
    worker.emit("message", {
      type: "ready",
      instance: { instanceId: "i", extensionId: "review-pack", contributionId: "review-panel", surface: "modal", canReceiveInput: true, focusInfo: { instanceId: "i", extensionId: "review-pack", contributionId: "review-panel", title: "t" } }
    });
    gate.focusHost("review-panel");
    expect(gate.blurCurrent()).toBe(true);
    expect(gate.getFocusedHost()).toBeUndefined();
  });

  it("sendInputToFocusedHost forwards events only while focused", () => {
    const gate = new LiveUiTrustGate();
    gate.allowed = true;
    const worker = new FakeWorker();
    gate.spawnHost({ entryPath: "/x.js", props: props(), host: host() }, {}, () => worker);
    worker.emit("message", {
      type: "ready",
      instance: { instanceId: "i", extensionId: "review-pack", contributionId: "review-panel", surface: "modal", canReceiveInput: true, focusInfo: { instanceId: "i", extensionId: "review-pack", contributionId: "review-panel", title: "t" } }
    });
    expect(gate.sendInputToFocusedHost({ name: "return" })).toBe(false);
    gate.focusHost("review-panel");
    expect(gate.sendInputToFocusedHost({ name: "return" })).toBe(true);
  });
});

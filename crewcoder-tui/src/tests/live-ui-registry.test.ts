import { describe, expect, it, vi } from "vitest";
import {
  LiveUiInstanceRegistry,
  type LiveUiDisposeReason,
  type LiveUiTrackable
} from "../bridge/live-ui-registry.js";
import type { CrewCoderLiveUiSurface } from "../bridge/live-ui-protocol.js";

function makeTrackable(overrides: Partial<LiveUiTrackable> = {}): LiveUiTrackable & { disposed: number } {
  const surface: CrewCoderLiveUiSurface = overrides.surface ?? "modal";
  return {
    disposed: 0,
    extensionId: overrides.extensionId ?? "review-pack",
    contributionId: overrides.contributionId ?? "review-panel",
    surface,
    activeInstance: overrides.activeInstance,
    async dispose() {
      this.disposed += 1;
    }
  };
}

describe("LiveUiInstanceRegistry", () => {
  it("registers instances by key and tracks size", () => {
    const registry = new LiveUiInstanceRegistry();
    registry.register({ key: "block-1", host: makeTrackable() });
    expect(registry.size).toBe(1);
    expect(registry.has("block-1")).toBe(true);
    expect(registry.get("block-1")?.extensionId).toBe("review-pack");
  });

  it("disposes and reports the reason when a block scrolls away", async () => {
    const onDispose = vi.fn();
    const registry = new LiveUiInstanceRegistry({ onDispose });
    const host = makeTrackable();
    registry.register({ key: "block-1", host, blockId: "b-42" });
    const count = await registry.disposeByBlock("b-42");
    expect(count).toBe(1);
    expect(host.disposed).toBe(1);
    expect(registry.size).toBe(0);
    const reason: LiveUiDisposeReason = onDispose.mock.calls[0][1];
    expect(reason).toBe("scroll_away");
  });

  it("disposes every instance on a closed surface", async () => {
    const registry = new LiveUiInstanceRegistry();
    const modalA = makeTrackable({ surface: "modal", contributionId: "a" });
    const modalB = makeTrackable({ surface: "modal", contributionId: "b" });
    const status = makeTrackable({ surface: "status", contributionId: "c" });
    registry.register({ key: "a", host: modalA });
    registry.register({ key: "b", host: modalB });
    registry.register({ key: "c", host: status });
    const count = await registry.disposeBySurface("modal");
    expect(count).toBe(2);
    expect(modalA.disposed).toBe(1);
    expect(modalB.disposed).toBe(1);
    expect(status.disposed).toBe(0);
    expect(registry.size).toBe(1);
  });

  it("disposes every instance owned by an unloaded extension", async () => {
    const registry = new LiveUiInstanceRegistry();
    const keep = makeTrackable({ extensionId: "other" });
    const drop = makeTrackable({ extensionId: "review-pack" });
    registry.register({ key: "keep", host: keep });
    registry.register({ key: "drop", host: drop });
    await registry.disposeByExtension("review-pack");
    expect(drop.disposed).toBe(1);
    expect(keep.disposed).toBe(0);
    expect(registry.has("keep")).toBe(true);
  });

  it("disposes everything on session end", async () => {
    const registry = new LiveUiInstanceRegistry();
    const a = makeTrackable({ contributionId: "a" });
    const b = makeTrackable({ contributionId: "b" });
    registry.register({ key: "a", host: a });
    registry.register({ key: "b", host: b });
    const count = await registry.disposeAll();
    expect(count).toBe(2);
    expect(registry.size).toBe(0);
  });

  it("routes dispose failures to onError and still drops the entry", async () => {
    const onError = vi.fn();
    const registry = new LiveUiInstanceRegistry({ onError });
    const host = makeTrackable();
    host.dispose = () => Promise.reject(new Error("boom"));
    registry.register({ key: "block-1", host });
    await registry.disposeByKey("block-1");
    expect(onError).toHaveBeenCalled();
    expect(registry.size).toBe(0);
  });
});

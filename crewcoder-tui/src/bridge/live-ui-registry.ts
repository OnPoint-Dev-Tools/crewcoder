/**
 * Live UI instance registry (lifecycle wiring, SLICE 1 hooks).
 *
 * Tracks live-UI host instances so the surrounding TUI can guarantee `dispose()`
 * fires on the boundaries a sandboxed worker must never outlive:
 *
 *   - a transcript block scrolls out of the retained window  -> disposeByBlock
 *   - an overlay/surface closes                              -> disposeBySurface
 *   - the session ends                                       -> disposeAll
 *   - an extension unloads                                   -> disposeByExtension
 *
 * The registry is intentionally decoupled from the render/overlay code. The
 * wiring layer registers a handle when it mounts a live component and calls the
 * matching `disposeBy*` hook when the boundary is crossed. `LiveUiHost` satisfies
 * `LiveUiTrackable`, but any object exposing the same read-only identity plus
 * `dispose()` can be tracked (which keeps this unit-testable with a fake host).
 */

import type { CrewCoderLiveUiInstance, CrewCoderLiveUiSurface } from "./live-ui-protocol.js";

export type LiveUiDisposeReason =
  | "scroll_away"
  | "overlay_close"
  | "session_end"
  | "extension_unload"
  | "manual";

/** Minimal lifecycle-bearing handle the registry needs; `LiveUiHost` satisfies it. */
export type LiveUiTrackable = {
  readonly extensionId: string;
  readonly contributionId: string;
  readonly surface: CrewCoderLiveUiSurface;
  readonly activeInstance: CrewCoderLiveUiInstance | undefined;
  dispose(): Promise<void>;
};

export type LiveUiRegistration = {
  /** Stable registry key. Use the transcript block id when the surface scrolls. */
  key: string;
  host: LiveUiTrackable;
  /** Optional transcript block id so scroll-away disposal can target the block. */
  blockId?: string;
};

export type LiveUiRegistryEntry = {
  key: string;
  blockId?: string;
  extensionId: string;
  contributionId: string;
  surface: CrewCoderLiveUiSurface;
  host: LiveUiTrackable;
};

export type LiveUiRegistryCallbacks = {
  onDispose?: (entry: LiveUiRegistryEntry, reason: LiveUiDisposeReason) => void;
  onError?: (entry: LiveUiRegistryEntry, error: unknown) => void;
};

export class LiveUiInstanceRegistry {
  private readonly entries = new Map<string, LiveUiRegistryEntry>();
  private readonly callbacks: LiveUiRegistryCallbacks;

  constructor(callbacks: LiveUiRegistryCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get size(): number {
    return this.entries.size;
  }

  list(): LiveUiRegistryEntry[] {
    return [...this.entries.values()];
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): LiveUiRegistryEntry | undefined {
    return this.entries.get(key);
  }

  register(registration: LiveUiRegistration): LiveUiRegistryEntry {
    const { key, host, blockId } = registration;
    const entry: LiveUiRegistryEntry = {
      key,
      ...(blockId === undefined ? {} : { blockId }),
      extensionId: host.extensionId,
      contributionId: host.contributionId,
      surface: host.surface,
      host
    };
    this.entries.set(key, entry);
    return entry;
  }

  /** Drop tracking without disposing (e.g. the host was disposed elsewhere). */
  unregister(key: string): void {
    this.entries.delete(key);
  }

  async disposeByKey(key: string, reason: LiveUiDisposeReason = "manual"): Promise<boolean> {
    const entry = this.entries.get(key);
    if (!entry) return false;
    await this.disposeEntry(entry, reason);
    return true;
  }

  /** A transcript block left the retained window. */
  disposeByBlock(blockId: string, reason: LiveUiDisposeReason = "scroll_away"): Promise<number> {
    return this.disposeMatching((entry) => entry.blockId === blockId, reason);
  }

  /** An overlay/surface closed. */
  disposeBySurface(surface: CrewCoderLiveUiSurface, reason: LiveUiDisposeReason = "overlay_close"): Promise<number> {
    return this.disposeMatching((entry) => entry.surface === surface, reason);
  }

  /** An extension unloaded. */
  disposeByExtension(extensionId: string, reason: LiveUiDisposeReason = "extension_unload"): Promise<number> {
    return this.disposeMatching((entry) => entry.extensionId === extensionId, reason);
  }

  /** The session ended; tear down every tracked instance. */
  disposeAll(reason: LiveUiDisposeReason = "session_end"): Promise<number> {
    return this.disposeMatching(() => true, reason);
  }

  private async disposeMatching(
    predicate: (entry: LiveUiRegistryEntry) => boolean,
    reason: LiveUiDisposeReason
  ): Promise<number> {
    const matches = [...this.entries.values()].filter(predicate);
    for (const entry of matches) await this.disposeEntry(entry, reason);
    return matches.length;
  }

  private async disposeEntry(entry: LiveUiRegistryEntry, reason: LiveUiDisposeReason): Promise<void> {
    this.entries.delete(entry.key);
    try {
      await entry.host.dispose();
      this.callbacks.onDispose?.(entry, reason);
    } catch (error) {
      this.callbacks.onError?.(entry, error);
    }
  }
}

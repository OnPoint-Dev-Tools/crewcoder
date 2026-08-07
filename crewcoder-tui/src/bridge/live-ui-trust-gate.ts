/**
 * Live UI trust gate (SLICE 1).
 *
 * Enforces the `allowExtensionLiveUi` config flag before any live-UI worker is
 * spawned or input is forwarded. Wraps `LiveUiHost` so the surrounding TUI
 * doesn't need to know about the trust check — it calls through the gate and
 * receives `null` when live UI execution is disallowed.
 */

import {
  LiveUiHost,
  type LiveUiHostCallbacks,
  type LiveUiSpawnOptions,
  type LiveUiWorkerFactory
} from "./live-ui-host.js";

export class LiveUiTrustGate {
  private hosts = new Map<string, LiveUiHost>();
  private focusedContributionId: string | undefined;
  private _allowed = false;

  get allowed(): boolean {
    return this._allowed;
  }

  set allowed(value: boolean) {
    this._allowed = value;
  }

  canExecute(): boolean {
    return this._allowed;
  }

  spawnHost(
    options: LiveUiSpawnOptions,
    callbacks?: LiveUiHostCallbacks,
    factory?: LiveUiWorkerFactory
  ): LiveUiHost | null {
    if (!this._allowed) return null;
    const key = options.props.contributionId;
    const existing = this.hosts.get(key);
    if (existing) return existing;
    const host = new LiveUiHost(options, callbacks, factory);
    this.hosts.set(key, host);
    host.spawn();
    return host;
  }

  getHost(contributionId: string): LiveUiHost | undefined {
    return this.hosts.get(contributionId);
  }

  focusHost(contributionId: string): boolean {
    const host = this.hosts.get(contributionId);
    if (!host) return false;
    if (this.focusedContributionId && this.focusedContributionId !== contributionId) {
      this.hosts.get(this.focusedContributionId)?.blur();
    }
    const focused = host.focus();
    if (focused) this.focusedContributionId = contributionId;
    return focused;
  }

  blurFocusedHost(): boolean {
    return this.blurCurrent();
  }

  /** Alias that matches the design-doc naming. Blurs whichever host owns focus. */
  blurCurrent(): boolean {
    if (!this.focusedContributionId) return false;
    const host = this.hosts.get(this.focusedContributionId);
    this.focusedContributionId = undefined;
    return host?.blur() ?? false;
  }

  getFocusedHost(): LiveUiHost | undefined {
    if (!this.focusedContributionId) return undefined;
    return this.hosts.get(this.focusedContributionId);
  }

  /**
   * A contribution is trusted when it has been spawned through the gate while the
   * gate is open. This is a lightweight runtime check; the real policy decision
   * (experimental flag, surface support, permissions) happens in `evaluateTuiLiveUiGate`
   * before `spawnHost` is called.
   */
  isTrusted(contributionId: string): boolean {
    if (!this._allowed) return false;
    return this.hosts.has(contributionId);
  }

  sendInputToFocusedHost(event: Parameters<LiveUiHost["sendInput"]>[0]): boolean {
    if (!this.focusedContributionId) return false;
    return this.hosts.get(this.focusedContributionId)?.sendInput(event) ?? false;
  }

  async disposeAll(): Promise<void> {
    for (const host of this.hosts.values()) await host.dispose();
    this.hosts.clear();
    this.focusedContributionId = undefined;
  }
}

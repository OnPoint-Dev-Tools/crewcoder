/**
 * Time a model call spends producing output, for the `durationMs` that hosts
 * divide `outputTokens` by to show throughput (tok/s).
 *
 * One `ModelClient.complete()` call can contain more than generation: Claude
 * Agent SDK and Codex run their own tool loop inside it, CrewCoder tools run
 * through `executeTool`, and approvals and questions wait for the user. Those
 * intervals are excluded. What remains is the provider's own time, including
 * time to first token and reasoning (reasoning tokens are part of the output).
 *
 * Pauses nest and overlap (parallel native tools, an approval inside a tool),
 * so time is excluded while at least one is open. If a provider tool never
 * reports its end, the duration is unknown and `finish()` returns undefined
 * rather than a number that silently excludes the rest of the call.
 */
export class GenerationClock {
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly openTools = new Set<string>();
  private openPauses = 0;
  private pausedAt = 0;
  private pausedTotal = 0;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
    this.startedAt = now();
  }

  /** A provider-native tool started; time stops until it (and every other open pause) ends. */
  toolStarted(id: string): void {
    if (this.openTools.has(id)) return;
    this.openTools.add(id);
    this.pause();
  }

  /** A provider-native tool ended. An end without a start is ignored. */
  toolEnded(id: string): void {
    if (!this.openTools.delete(id)) return;
    this.resume();
  }

  /** Run work that is not generation (tool execution, waiting for the user) with the clock paused. */
  async excluding<T>(work: () => Promise<T>): Promise<T> {
    this.pause();
    try {
      return await work();
    } finally {
      this.resume();
    }
  }

  /** Milliseconds of generation so far, or undefined while a provider tool is still open. */
  finish(): number | undefined {
    if (this.openTools.size > 0) return undefined;
    const pausedNow = this.openPauses > 0 ? this.now() - this.pausedAt : 0;
    return Math.max(0, this.now() - this.startedAt - this.pausedTotal - pausedNow);
  }

  private pause(): void {
    if (this.openPauses++ === 0) this.pausedAt = this.now();
  }

  private resume(): void {
    if (this.openPauses === 0) return;
    if (--this.openPauses === 0) this.pausedTotal += this.now() - this.pausedAt;
  }
}

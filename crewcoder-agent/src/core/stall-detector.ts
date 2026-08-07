/**
 * Runaway-loop detection for the agent loop.
 *
 * CrewCoder does not cap iterations by default: a working agent should run as
 * long as the task needs. Iteration counts bound nothing meaningful. What we do
 * bound is *pathological* behavior, so this detector only trips on evidence the
 * agent has stopped making progress:
 *
 *   1. the same tool call (name + arguments) repeated back-to-back
 *   2. a run of consecutive failing tool calls
 *
 * Both counters reset the moment the agent does something different or something
 * succeeds, so a healthy long-running agent never trips them.
 */

export type StallToolCall = { name: string; arguments: Record<string, unknown>; isError: boolean };

export type StallDetectorConfig = {
  /** Identical consecutive tool calls before the run is considered stuck. */
  repeatThreshold: number;
  /** Consecutive failing tool calls before the run is considered stuck. */
  errorThreshold: number;
};

export const DEFAULT_STALL_CONFIG: StallDetectorConfig = { repeatThreshold: 3, errorThreshold: 8 };

export type StallDetector = {
  /** Records a completed tool call. Returns a human-readable reason when the run has stalled. */
  record(call: StallToolCall): string | undefined;
};

/**
 * Stable signature for a tool call. Object keys are sorted so that argument
 * ordering from the provider never masks an identical repeat.
 */
export function toolCallSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

export function createStallDetector(config: StallDetectorConfig = DEFAULT_STALL_CONFIG): StallDetector {
  const repeatThreshold = Math.max(2, config.repeatThreshold);
  const errorThreshold = Math.max(2, config.errorThreshold);
  let lastSignature: string | undefined;
  let repeatCount = 0;
  let consecutiveErrors = 0;

  return {
    record(call: StallToolCall): string | undefined {
      const signature = toolCallSignature(call.name, call.arguments);
      repeatCount = signature === lastSignature ? repeatCount + 1 : 1;
      lastSignature = signature;
      consecutiveErrors = call.isError ? consecutiveErrors + 1 : 0;

      if (repeatCount >= repeatThreshold) {
        return `Stalled: ${call.name} was called ${repeatCount} times in a row with identical arguments and no progress.`;
      }
      if (consecutiveErrors >= errorThreshold) {
        return `Stalled: ${consecutiveErrors} consecutive tool calls failed without progress (last: ${call.name}).`;
      }
      return undefined;
    }
  };
}

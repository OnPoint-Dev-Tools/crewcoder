import { describe, expect, it } from "vitest";
import { GenerationClock } from "../core/generation-clock.js";

/** A hand-driven clock: `advance` moves time forward. */
function fakeTime(): { now: () => number; advance: (ms: number) => void } {
  let time = 1_000;
  return { now: () => time, advance: (ms) => { time += ms; } };
}

describe("GenerationClock", () => {
  it("counts the whole call when nothing is excluded", () => {
    const time = fakeTime();
    const clock = new GenerationClock(time.now);
    time.advance(2_000);
    expect(clock.finish()).toBe(2_000);
  });

  it("leaves out provider tool time, including overlapping tools", () => {
    const time = fakeTime();
    const clock = new GenerationClock(time.now);
    time.advance(500);
    clock.toolStarted("a");
    time.advance(1_000);
    clock.toolStarted("b");
    time.advance(1_000);
    clock.toolEnded("a");
    time.advance(1_000);
    clock.toolEnded("b");
    time.advance(500);
    expect(clock.finish()).toBe(1_000);
  });

  it("ignores repeated starts and ends without a start", () => {
    const time = fakeTime();
    const clock = new GenerationClock(time.now);
    clock.toolEnded("never-started");
    clock.toolStarted("a");
    clock.toolStarted("a");
    time.advance(1_000);
    clock.toolEnded("a");
    time.advance(300);
    expect(clock.finish()).toBe(300);
  });

  it("leaves out excluded work (tool execution, user questions), nested inside a tool", async () => {
    const time = fakeTime();
    const clock = new GenerationClock(time.now);
    time.advance(200);
    clock.toolStarted("a");
    await clock.excluding(async () => {
      time.advance(5_000);
    });
    time.advance(100);
    clock.toolEnded("a");
    time.advance(200);
    expect(clock.finish()).toBe(400);
  });

  it("resumes after excluded work that throws", async () => {
    const time = fakeTime();
    const clock = new GenerationClock(time.now);
    await expect(clock.excluding(async () => {
      time.advance(1_000);
      throw new Error("denied");
    })).rejects.toThrow("denied");
    time.advance(250);
    expect(clock.finish()).toBe(250);
  });

  it("reports no duration while a provider tool never ended", () => {
    const time = fakeTime();
    const clock = new GenerationClock(time.now);
    clock.toolStarted("lost");
    time.advance(1_000);
    expect(clock.finish()).toBeUndefined();
  });
});

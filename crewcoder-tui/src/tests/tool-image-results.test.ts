import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachmentFromToolImage, toolImageAttachments } from "../state/image-attachment.js";
import { applyCrewCoderEvent } from "../state/event-reducer.js";
import { createInitialState, type TuiState } from "../state/tui-store.js";
import { MainViewport } from "../components/MainViewport.js";
import { crewCoderTheme } from "../theme/theme.js";
import { stripAnsi } from "../tui/ansi.js";
import type { RenderedImagePlacement } from "../tui/component.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-tui-tool-images-"));
});

afterEach(() => {
  fs.rmSync(dir, { force: true, recursive: true });
});

function writePng(name: string, width = 800, height = 600): string {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return file;
}

function state(): TuiState {
  // The initial state seeds a welcome block; drop it so assertions are about
  // exactly what the event added.
  return { ...createInitialState(), blocks: [] };
}

function toolEnd(metadata: Record<string, unknown>, isError = false) {
  return { type: "tool_execution_end", toolName: "read", toolCallId: "call_1", isError, metadata } as never;
}

describe("attachmentFromToolImage", () => {
  it("sniffs real dimensions off disk rather than trusting the payload", () => {
    const file = writePng("shot.png", 1920, 1080);
    const attachment = attachmentFromToolImage({ path: file, displayPath: "shot.png", mime: "image/gif", byteSize: 99 });

    expect(attachment).toMatchObject({ path: file, name: "shot.png", width: 1920, height: 1080, source: "tool" });
    // The tool claimed gif and the wrong size; the bytes win.
    expect(attachment?.mime).toBe("image/png");
    expect(attachment?.byteSize).toBe(24);
  });

  it("does not copy the file into the image cache", () => {
    const file = writePng("shot.png");
    expect(attachmentFromToolImage({ path: file })?.path).toBe(file);
    expect(fs.readdirSync(dir)).toEqual(["shot.png"]);
  });

  it("gives the same file a stable id so repeats reuse one placement", () => {
    const file = writePng("shot.png");
    expect(attachmentFromToolImage({ path: file })?.id).toBe(attachmentFromToolImage({ path: file })?.id);
  });

  it("rejects payloads that are not readable images", () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello", "utf8");
    expect(attachmentFromToolImage({ path: path.join(dir, "notes.txt") })).toBeUndefined();
    expect(attachmentFromToolImage({ path: path.join(dir, "missing.png") })).toBeUndefined();
    expect(attachmentFromToolImage({ path: dir })).toBeUndefined();
    expect(attachmentFromToolImage({ path: "  " })).toBeUndefined();
    expect(attachmentFromToolImage("nope")).toBeUndefined();
  });
});

describe("toolImageAttachments", () => {
  it("returns nothing when metadata declares no images", () => {
    expect(toolImageAttachments(undefined)).toEqual([]);
    expect(toolImageAttachments({ path: "a.ts" })).toEqual([]);
    expect(toolImageAttachments({ images: "not-an-array" })).toEqual([]);
  });

  it("keeps the readable images and drops the broken ones", () => {
    const file = writePng("shot.png");
    const attachments = toolImageAttachments({ images: [{ path: file }, { path: path.join(dir, "gone.png") }] });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.path).toBe(file);
  });
});

describe("tool_execution_end image blocks", () => {
  it("pushes an image block under the tool block", () => {
    const file = writePng("shot.png");
    const next = state();
    applyCrewCoderEvent(next, toolEnd({ path: "shot.png", images: [{ path: file, displayPath: "shot.png" }] }));

    const types = next.blocks.map((block) => block.type);
    expect(types).toEqual(["tool", "image"]);
    const image = next.blocks.find((block) => block.type === "image");
    expect(image).toMatchObject({ type: "image", attachment: { source: "tool", name: "shot.png" } });
  });

  it("does not duplicate a placement when the same image is reported twice", () => {
    const file = writePng("shot.png");
    const next = state();
    applyCrewCoderEvent(next, toolEnd({ images: [{ path: file }] }));
    applyCrewCoderEvent(next, toolEnd({ images: [{ path: file }] }));

    expect(next.blocks.filter((block) => block.type === "image")).toHaveLength(1);
  });

  it("renders no image for a failed tool call", () => {
    const file = writePng("shot.png");
    const next = state();
    applyCrewCoderEvent(next, toolEnd({ images: [{ path: file }] }, true));

    expect(next.blocks.some((block) => block.type === "image")).toBe(false);
  });

  it("leaves normal tool results untouched", () => {
    const next = state();
    applyCrewCoderEvent(next, toolEnd({ path: "a.ts", bytes: 20 }));
    expect(next.blocks.map((block) => block.type)).toEqual(["tool"]);
  });
});

describe("viewport rendering of a tool image", () => {
  it("labels a tool image distinctly from a pasted one and reserves graphics rows", () => {
    const file = writePng("chart.png", 1200, 600);
    const next = state();
    applyCrewCoderEvent(next, toolEnd({ images: [{ path: file, displayPath: "chart.png" }] }));

    const placements: RenderedImagePlacement[] = [];
    const viewport = new MainViewport(next);
    const plain = viewport
      .render({ theme: crewCoderTheme, size: { width: 80, height: 30 }, imagePlacements: placements })
      .map(stripAnsi)
      .join("\n");

    expect(plain).toContain("TOOL IMAGE");
    expect(plain).toContain("chart.png");
    // A pasted screenshot must not be relabelled by this change.
    const pasted = state();
    pasted.blocks.push({ type: "image", attachment: { ...attachmentFromToolImage({ path: file })!, source: "clipboard" } });
    const pastedPlain = new MainViewport(pasted)
      .render({ theme: crewCoderTheme, size: { width: 80, height: 30 }, imagePlacements: [] })
      .map(stripAnsi)
      .join("\n");
    expect(pastedPlain).toContain("IMAGE");
    expect(pastedPlain).not.toContain("TOOL IMAGE");
  });
});

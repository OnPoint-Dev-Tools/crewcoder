import { describe, expect, it } from "vitest";
import { App } from "../components/App.js";
import { Composer } from "../components/Composer.js";
import { MainViewport } from "../components/MainViewport.js";
import { createInitialState } from "../state/tui-store.js";
import type { ImageAttachment } from "../state/image-attachment.js";
import { crewCoderTheme } from "../theme/theme.js";
import { stripAnsi } from "../tui/ansi.js";
import type { RenderedImagePlacement } from "../tui/component.js";

function attachment(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: "img_test",
    path: "/tmp/.crewcoder/cache/images/img_test.png",
    name: "img_test.png",
    mime: "image/png",
    width: 1280,
    height: 720,
    byteSize: 24576,
    source: "clipboard",
    ...overrides
  };
}

describe("Composer attachments", () => {
  it("renders an attachment chip and grows in height when an image is pending", () => {
    const state = createInitialState();
    const composer = new Composer(state, () => {});
    const baseHeight = composer.height(60);

    state.attachments = [attachment()];
    const grownHeight = composer.height(60);
    const plain = composer.render({ theme: crewCoderTheme, size: { width: 60, height: 12 } }).map(stripAnsi).join("\n");

    expect(grownHeight).toBe(baseHeight + 1);
    expect(plain).toContain("IMG 1");
    expect(plain).toContain("1280×720");
  });

  it("submits when only an image is attached and the text is empty", () => {
    const state = createInitialState();
    const submitted: string[] = [];
    const composer = new Composer(state, (value) => submitted.push(value));
    state.attachments = [attachment()];

    composer.handleInput?.({ name: "return", sequence: "\r", ctrl: false, meta: false, shift: false });

    expect(submitted).toEqual([""]);
  });

  it("clears pending attachments on ctrl+x", () => {
    const state = createInitialState();
    const composer = new Composer(state, () => {});
    state.attachments = [attachment()];

    const handled = composer.handleInput?.({ name: "x", sequence: "", ctrl: true, meta: false, shift: false });

    expect(handled).toBe(true);
    expect(state.attachments).toEqual([]);
  });
});

describe("MainViewport image block", () => {
  it("renders an image preview block with filename, dimensions, and path", () => {
    const state = createInitialState();
    state.blocks = [{ type: "image", attachment: attachment() }];
    const viewport = new MainViewport(state);

    const plain = viewport.render({ theme: crewCoderTheme, size: { width: 80, height: 20 } }).map(stripAnsi).join("\n");

    expect(plain).toContain("IMAGE");
    expect(plain).toContain("img_test.png");
    expect(plain).toContain("1280×720");
    expect(plain).toContain("image/png");
  });

  it("reports a terminal graphics placement when kitty rendering is enabled", () => {
    const original = process.env.CREWCODER_TUI_IMAGE_PROTOCOL;
    process.env.CREWCODER_TUI_IMAGE_PROTOCOL = "kitty";
    try {
      const state = createInitialState();
      state.blocks = [{ type: "image", attachment: attachment() }];
      const imagePlacements: RenderedImagePlacement[] = [];
      const lines = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 80, height: 24 }, imagePlacements });
      const plain = lines.map(stripAnsi).join("\n");

      expect(plain).toContain("kitty graphics preview");
      expect(imagePlacements).toHaveLength(1);
      expect(imagePlacements[0]).toMatchObject({ id: "img_test", protocol: "kitty", row: expect.any(Number), col: 3 });
      expect(imagePlacements[0]?.placement.rows).toBeGreaterThan(1);
    } finally {
      if (original === undefined) delete process.env.CREWCODER_TUI_IMAGE_PROTOCOL;
      else process.env.CREWCODER_TUI_IMAGE_PROTOCOL = original;
    }
  });
});

describe("App image placement rows", () => {
  it("suppresses an image behind an opaque modal and restores it when the modal closes", () => {
    const original = process.env.CREWCODER_TUI_IMAGE_PROTOCOL;
    process.env.CREWCODER_TUI_IMAGE_PROTOCOL = "kitty";
    try {
      const state = createInitialState();
      state.sessionId = "sess_1";
      state.blocks = [
        { type: "user", text: "review this screenshot" },
        { type: "image", attachment: attachment() }
      ];
      const app = new App(state);
      const size = { width: 100, height: 32 };
      const before: RenderedImagePlacement[] = [];
      app.render({ theme: crewCoderTheme, size, imagePlacements: before });
      expect(before).toHaveLength(1);

      (app as unknown as { handleCrewCoderEvent: (event: Record<string, unknown>) => void }).handleCrewCoderEvent({
        type: "approval_required",
        approvalId: "approval_modal_image",
        toolCallId: "call_1",
        toolName: "write",
        risk: "review",
        reason: "Confirm this operation.",
        args: { path: "README.md" }
      });
      const outsideModal: RenderedImagePlacement = {
        id: "outside_modal",
        row: 1,
        col: 1,
        protocol: "kitty",
        attachment: attachment({ id: "outside_modal" }),
        placement: { cols: 1, rows: 1 }
      };
      const covered: RenderedImagePlacement[] = [outsideModal];
      app.render({ theme: crewCoderTheme, size, imagePlacements: covered });
      expect(covered).toEqual([outsideModal]);

      (app as unknown as { handleCrewCoderEvent: (event: Record<string, unknown>) => void }).handleCrewCoderEvent({
        type: "approval_resolved",
        approvalId: "approval_modal_image",
        approved: false
      });
      const restored: RenderedImagePlacement[] = [];
      app.render({ theme: crewCoderTheme, size, imagePlacements: restored });
      expect(restored).toHaveLength(1);
    } finally {
      if (original === undefined) delete process.env.CREWCODER_TUI_IMAGE_PROTOCOL;
      else process.env.CREWCODER_TUI_IMAGE_PROTOCOL = original;
    }
  });

  it("keeps viewport placements inside the reserved block without a header offset", () => {
    const original = process.env.CREWCODER_TUI_IMAGE_PROTOCOL;
    process.env.CREWCODER_TUI_IMAGE_PROTOCOL = "kitty";
    try {
      const state = createInitialState();
      state.sessionId = "sess_1";
      state.blocks = [
        { type: "user", text: "here is the screenshot" },
        { type: "image", attachment: attachment() }
      ];
      const imagePlacements: RenderedImagePlacement[] = [];
      const lines = new App(state)
        .render({ theme: crewCoderTheme, size: { width: 100, height: 32 }, imagePlacements })
        .map(stripAnsi);

      expect(imagePlacements).toHaveLength(1);
      const placement = imagePlacements[0]!;
      // With no persistent header, viewport rows are already terminal rows. Every
      // row the image covers must be reserved blank space, never the user message
      // or the block's own label.
      for (let row = placement.row; row < placement.row + placement.placement.rows; row++) {
        expect(lines[row - 1]?.trim()).toBe("");
      }
      const labelRow = lines.findIndex((line) => line.includes("IMAGE img_test.png"));
      expect(labelRow).toBeGreaterThanOrEqual(0);
      expect(placement.row).toBeGreaterThan(labelRow + 1);
    } finally {
      if (original === undefined) delete process.env.CREWCODER_TUI_IMAGE_PROTOCOL;
      else process.env.CREWCODER_TUI_IMAGE_PROTOCOL = original;
    }
  });
});

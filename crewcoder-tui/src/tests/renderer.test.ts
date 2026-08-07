import { afterEach, describe, expect, it, vi } from "vitest";
import { Renderer } from "../tui/renderer.js";
import type { Component, RenderContext } from "../tui/component.js";
import { crewCoderTheme } from "../theme/theme.js";
import { encodeKittyDeleteImage, encodeKittyDeleteVisibleImages, encodeKittyImage } from "../tui/image-protocol.js";

class StaticRoot implements Component {
  render(ctx: RenderContext): string[] {
    return ["ok".padEnd(ctx.size.width, " ")];
  }
}

class ImageRoot implements Component {
  row = 2;
  label = "image";
  underlayLabel = "";

  render(ctx: RenderContext): string[] {
    ctx.imagePlacements?.push({
      id: "img_test",
      row: this.row,
      col: 3,
      protocol: "kitty",
      attachment: {
        id: "img_test",
        path: "/tmp/img_test.png",
        name: "img_test.png",
        mime: "image/png",
        width: 10,
        height: 10,
        byteSize: 4,
        source: "clipboard"
      },
      placement: { cols: 5, rows: 2 }
    });
    return [this.label, this.underlayLabel, ""];
  }
}

type FakeWriteStream = NodeJS.WriteStream & { output: string };

function fakeWriteStream(): FakeWriteStream {
  return {
    columns: 10,
    rows: 3,
    output: "",
    write(chunk: string) {
      this.output += chunk;
      return true;
    }
  } as FakeWriteStream;
}

describe("Renderer terminal integration", () => {
  const originalMouse = process.env.CREWCODER_TUI_MOUSE;

  afterEach(() => {
    vi.useRealTimers();
    if (originalMouse === undefined) delete process.env.CREWCODER_TUI_MOUSE;
    else process.env.CREWCODER_TUI_MOUSE = originalMouse;
  });

  it("sets and resets the terminal background color", () => {
    const out = fakeWriteStream();
    const renderer = new Renderer(new StaticRoot(), crewCoderTheme, out);

    renderer.start();
    renderer.stop();

    expect(out.output).toContain(`\x1b]11;${crewCoderTheme.background}\x07`);
    expect(out.output).toContain("\x1b]111\x07");
  });

  it("force paints every terminal row explicitly", () => {
    const out = fakeWriteStream();

    new Renderer(new StaticRoot(), crewCoderTheme, out).start();

    expect(out.output).toContain("\x1b[1;1H");
    expect(out.output).toContain("\x1b[2;1H");
    expect(out.output).toContain("\x1b[3;1H");
  });

  it("enables and resets terminal focus reporting for instance-local input", () => {
    const out = fakeWriteStream();
    const renderer = new Renderer(new StaticRoot(), crewCoderTheme, out);

    renderer.start();
    renderer.stop();

    expect(out.output).toContain("\x1b[?1004h");
    expect(out.output).toContain("\x1b[?1004l");
  });

  it("enables mouse reporting by default for TUI mouse selection", () => {
    delete process.env.CREWCODER_TUI_MOUSE;
    const out = fakeWriteStream();

    new Renderer(new StaticRoot(), crewCoderTheme, out).start();

    expect(out.output).toContain("\x1b[?1000h\x1b[?1003h\x1b[?1006h");
  });

  it("can opt out of mouse reporting for terminal context menus", () => {
    process.env.CREWCODER_TUI_MOUSE = "0";
    const out = fakeWriteStream();

    new Renderer(new StaticRoot(), crewCoderTheme, out).start();

    expect(out.output).not.toContain("\x1b[?1000h");
    expect(out.output).not.toContain("\x1b[?1002h");
    expect(out.output).not.toContain("\x1b[?1006h");
  });

  it("draws and clears kitty image placements", () => {
    const out = fakeWriteStream();
    const renderer = new Renderer(new ImageRoot(), crewCoderTheme, out);

    renderer.start();
    renderer.stop();

    expect(out.output).toContain("\x1b[2;3H");
    expect(out.output).toContain(encodeKittyImage("/tmp/img_test.png", { cols: 5, rows: 2 }, "img_test"));
    expect(out.output).toContain(encodeKittyDeleteImage("img_test"));
    expect(out.output).toContain(encodeKittyDeleteVisibleImages());
  });

  it("leaves a settled image untouched when unrelated text changes", () => {
    vi.useFakeTimers();
    const out = fakeWriteStream();
    const root = new ImageRoot();
    const renderer = new Renderer(root, crewCoderTheme, out);

    renderer.start();
    // Row 1 changes (the spinner case); the image occupies rows 2-3 and did not move.
    root.label = "working";
    out.output = "";
    renderer.render();

    expect(out.output).toContain("\x1b[1;1H");
    expect(out.output).not.toContain(encodeKittyDeleteImage("img_test"));
    expect(out.output).not.toContain(encodeKittyDeleteVisibleImages());
    expect(out.output).not.toContain(encodeKittyImage("/tmp/img_test.png", { cols: 5, rows: 2 }, "img_test"));

    vi.advanceTimersByTime(500);
    expect(out.output).not.toContain(encodeKittyImage("/tmp/img_test.png", { cols: 5, rows: 2 }, "img_test"));
  });

  it("redraws the image when repainted text overlaps its rows", () => {
    vi.useFakeTimers();
    const out = fakeWriteStream();
    const root = new ImageRoot();
    const renderer = new Renderer(root, crewCoderTheme, out);

    renderer.start();
    // Row 2 is under the image, so the repaint would overwrite its pixels.
    root.underlayLabel = "overlap";
    out.output = "";
    renderer.render();

    expect(out.output).toContain(encodeKittyDeleteVisibleImages());
    vi.advanceTimersByTime(100);
    expect(out.output).toContain(encodeKittyImage("/tmp/img_test.png", { cols: 5, rows: 2 }, "img_test"));
  });

  it("debounces kitty image redraws on diff renders", () => {
    vi.useFakeTimers();
    const out = fakeWriteStream();
    const root = new ImageRoot();
    const renderer = new Renderer(root, crewCoderTheme, out);

    renderer.start();
    root.row = 1;
    root.label = "scrolled";
    out.output = "";
    renderer.render();

    expect(out.output).toContain(encodeKittyDeleteImage("img_test"));
    expect(out.output).toContain(encodeKittyDeleteVisibleImages());
    expect(out.output).toContain("\x1b[1;1H");
    expect(out.output).not.toContain(encodeKittyImage("/tmp/img_test.png", { cols: 5, rows: 2 }, "img_test"));

    vi.advanceTimersByTime(99);
    expect(out.output).not.toContain(encodeKittyImage("/tmp/img_test.png", { cols: 5, rows: 2 }, "img_test"));
    vi.advanceTimersByTime(1);
    expect(out.output).toContain("\x1b[1;3H");
    expect(out.output).toContain(encodeKittyImage("/tmp/img_test.png", { cols: 5, rows: 2 }, "img_test"));
  });
});

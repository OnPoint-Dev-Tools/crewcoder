import type { CrewCoderTheme } from "../theme/theme.js";
import type { ImageAttachment } from "../state/image-attachment.js";
import type { ImagePlacement, ImageProtocol } from "./image-protocol.js";

export type Size = { width: number; height: number };

export type RenderedImagePlacement = {
  id: string;
  row: number;
  col: number;
  protocol: Exclude<ImageProtocol, "none">;
  attachment: ImageAttachment;
  placement: ImagePlacement;
};

export type RenderContext = {
  theme: CrewCoderTheme;
  size: Size;
  imagePlacements?: RenderedImagePlacement[];
};

export type MouseEventKind = "press" | "drag" | "release" | "wheel" | "hover";

export type KeyEvent = {
  name: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  mouse?: {
    x: number;
    y: number;
    button: number;
    kind: MouseEventKind;
  };
};

export interface Component {
  render(ctx: RenderContext): string[];
  handleInput?(event: KeyEvent): void | boolean;
  invalidate?(): void;
}

export abstract class BaseComponent implements Component {
  private invalid = true;
  abstract render(ctx: RenderContext): string[];
  invalidate(): void { this.invalid = true; }
  consumeInvalid(): boolean {
    const value = this.invalid;
    this.invalid = false;
    return value;
  }
}

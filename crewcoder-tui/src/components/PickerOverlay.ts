import type { Component, KeyEvent, RenderContext } from "../tui/component.js";
import { modalChromeHeight, modalRowAt, renderModalView } from "./modal-view.js";

export type PickerOption = {
  label: string;
  value: string;
  description?: string;
};

export class PickerOverlay implements Component {
  private selected = 0;
  private lastHeight = 1;

  constructor(
    private readonly title: string,
    private readonly options: PickerOption[],
    private readonly onSelect: (option: PickerOption) => void
  ) {}

  render(ctx: RenderContext): string[] {
    this.lastHeight = ctx.size.height;
    return renderModalView(ctx, {
      title: this.title,
      rows: this.options.map((option) => ({ label: option.label, hint: option.description })),
      selected: this.selected,
      footer: "↑↓ navigate   ↵ select   esc close",
      emptyText: "No options available"
    });
  }

  desiredHeight(): number {
    const rows = Math.min(Math.max(this.options.length, 1), 12);
    return rows + modalChromeHeight({ footer: true });
  }

  handleInput(event: KeyEvent): boolean {
    if (!this.options.length) return false;
    if (event.name === "mouse" && event.mouse?.kind === "press") {
      const rows = this.options.map((option) => ({ label: option.label, hint: option.description }));
      const index = modalRowAt(rows, this.selected, this.lastHeight, event.mouse.y, { footer: true });
      if (index === undefined) return true;
      this.selected = index;
      this.onSelect(this.options[index]!);
      return true;
    }
    if (event.name === "up") {
      this.selected = Math.max(0, this.selected - 1);
      return true;
    }
    if (event.name === "down") {
      this.selected = Math.min(this.options.length - 1, this.selected + 1);
      return true;
    }
    if (event.name === "return") {
      this.onSelect(this.options[this.selected]!);
      return true;
    }
    return false;
  }
}

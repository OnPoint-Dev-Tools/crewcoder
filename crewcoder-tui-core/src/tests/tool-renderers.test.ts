import { describe, expect, it } from "vitest";
import { parseExtensionRendererRecords } from "../bridge/crewcoder-process.js";
import { findToolRenderer, rendererMatchesTool, renderToolTemplate } from "../state/tool-renderers.js";
import type { TuiEventBlock, TuiRendererHook } from "../state/tui-store.js";

type ToolBlock = Extract<TuiEventBlock, { type: "tool" }>;

const tool = (overrides: Partial<ToolBlock> = {}): ToolBlock => ({
  type: "tool", id: "t1", name: "deploy", status: "done",
  args: { target: { env: "prod" }, count: 3, flags: ["a"] },
  metadata: { extensionId: "ext.ship", toolId: "deploy", renderer: "card" },
  text: "deployed",
  ...overrides
});

const hook = (match: TuiRendererHook["match"], template = "{{name}}"): TuiRendererHook => ({ extensionId: "ext.ship", id: "card", title: "Deploy", target: "tool", match, template });

describe("rendererMatchesTool", () => {
  it("requires every field the match sets", () => {
    expect(rendererMatchesTool({ extensionId: "ext.ship", toolId: "deploy" }, tool())).toBe(true);
    expect(rendererMatchesTool({ toolName: "deploy", renderer: "card" }, tool())).toBe(true);
    expect(rendererMatchesTool({ extensionId: "ext.other" }, tool())).toBe(false);
    expect(rendererMatchesTool({ toolName: "bash" }, tool())).toBe(false);
    expect(rendererMatchesTool({ renderer: "card" }, tool({ metadata: undefined }))).toBe(false);
  });

  it("never matches with an empty match, so no extension can redraw every tool", () => {
    expect(rendererMatchesTool({}, tool())).toBe(false);
    expect(findToolRenderer(tool({ name: "bash" }), [hook({})])).toBeUndefined();
  });

  it("picks the first matching tool renderer", () => {
    const first = hook({ toolName: "deploy" });
    const second = hook({ extensionId: "ext.ship" });
    expect(findToolRenderer(tool(), [hook({ toolName: "bash" }), first, second])).toBe(first);
    expect(findToolRenderer(tool(), [])).toBeUndefined();
  });
});

describe("renderToolTemplate", () => {
  it("fills name, status, text, nested args and metadata; objects as JSON; unknown paths empty", () => {
    const template = "{{ name }}/{{status}}: {{text}} env={{args.target.env}} n={{args.count}} f={{args.flags}} r={{metadata.renderer}} x=[{{args.missing.deep}}] y=[{{nope}}]";
    expect(renderToolTemplate(template, tool())).toBe('deploy/done: deployed env=prod n=3 f=["a"] r=card x=[] y=[]');
  });

  it("leaves text that is not a placeholder alone", () => {
    expect(renderToolTemplate("{{ bad path! }} {plain}", tool())).toBe("{{ bad path! }} {plain}");
  });
});

describe("parseExtensionRendererRecords", () => {
  it("keeps only well-formed tool renderers", () => {
    const records = parseExtensionRendererRecords([
      { extensionId: "ext.ship", id: "card", title: "Deploy", target: "tool", match: { toolName: "deploy", extra: 1 }, template: "{{text}}" },
      { extensionId: "ext.ship", id: "bad", title: "No match", target: "tool", template: "x" },
      { extensionId: "ext.ship", id: "view", title: "Other target", target: "message", match: {}, template: "x" },
      "junk"
    ]);
    expect(records).toEqual([{ extensionId: "ext.ship", id: "card", title: "Deploy", target: "tool", match: { toolName: "deploy" }, template: "{{text}}" }]);
    expect(parseExtensionRendererRecords({})).toEqual([]);
  });
});

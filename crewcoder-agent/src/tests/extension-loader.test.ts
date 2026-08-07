import { describe, expect, it } from "vitest";
import { validateExtensionManifest } from "../extensions/extension-loader.js";

describe("CrewCoder extension manifests", () => {
  it("accepts a declarative provider extension", () => {
    expect(() => validateExtensionManifest({
      id: "x", name: "X", version: "0.1.0", crewcoder: { apiVersion: "0.1" },
      contributes: { providers: [{ id: "p", title: "P", runtime: "process", command: "echo", args: ["{{prompt}}"] }] }
    })).not.toThrow();
  });

  it("accepts a capability-based extension without requiring a kind", () => {
    const warnings: string[] = [];
    expect(() => validateExtensionManifest({
      id: "repo-superpowers",
      name: "Repo Superpowers",
      version: "0.1.0",
      crewcoder: { apiVersion: "0.1" },
      activation: { keywords: ["repo"], events: ["onPrompt"], modes: ["auto"], commands: ["repo.audit"], filePatterns: ["**/*.ts"] },
      contributes: {
        providers: [],
        skills: [{ id: "audit", title: "Audit", description: "Audit repos.", triggers: ["audit"], prompt: "Check risks." }],
        promptPacks: [{ id: "reviews", title: "Reviews", prompts: [{ id: "security", title: "Security", content: "Check secrets." }] }],
        commands: [{ id: "repo.audit", title: "Repo Audit" }],
        workflows: [{ id: "ship", title: "Ship", steps: [{ kind: "prompt", prompt: "Summarize the release." }] }],
        contextProviders: [{ id: "repo-map", title: "Repo Map" }],
        validators: [{ id: "no-secrets", title: "No Secrets" }],
        approvalPolicies: [{ id: "safe-edits", title: "Safe Edits" }],
        hooks: [{ id: "before-run", title: "Before Run" }],
        ui: [{ id: "panel", title: "Panel" }],
        customFuturePoint: [{ id: "future", title: "Future" }]
      }
    }, warnings)).not.toThrow();
    expect(warnings.some((warning) => warning.includes("contextProviders"))).toBe(true);
  });

  it("accepts file trigger contributions", () => {
    const warnings: string[] = [];
    expect(() => validateExtensionManifest({
      id: "trigger-pack",
      name: "Trigger Pack",
      version: "0.1.0",
      crewcoder: { apiVersion: "0.1" },
      contributes: {
        fileTriggers: [{ id: "docs", title: "Docs", patterns: ["docs/**/*.md"], command: "node", args: ["./on-change.js", "{{path}}"] }]
      }
    }, warnings)).not.toThrow();
    expect(warnings.some((warning) => warning.includes("file triggers"))).toBe(true);
  });

  it("rejects malformed file trigger contributions", () => {
    expect(() => validateExtensionManifest({
      id: "bad-trigger", name: "Bad Trigger", version: "0.1.0", crewcoder: { apiVersion: "0.1" },
      contributes: { fileTriggers: [{ id: "broken", title: "Broken", patterns: [], command: "node" }] }
    })).toThrow("patterns");
  });

  it("accepts approval policy contributions", () => {
    const warnings: string[] = [];
    expect(() => validateExtensionManifest({
      id: "safety-pack",
      name: "Safety Pack",
      version: "0.1.0",
      crewcoder: { apiVersion: "0.1" },
      contributes: {
        approvalPolicies: [{ id: "protect-env", title: "Protect env", action: "block", paths: [".env*"], reason: "Secrets are protected" }]
      }
    }, warnings)).not.toThrow();
    expect(warnings.some((warning) => warning.includes("approval policies"))).toBe(true);
  });

  it("rejects malformed approval policy contributions", () => {
    expect(() => validateExtensionManifest({
      id: "bad-policy", name: "Bad Policy", version: "0.1.0", crewcoder: { apiVersion: "0.1" },
      contributes: { approvalPolicies: [{ id: "broken", title: "Broken", action: "maybe" }] }
    })).toThrow("action must be one of");
  });

  it("accepts declarative TUI renderer contributions", () => {
    const warnings: string[] = [];
    expect(() => validateExtensionManifest({
      id: "render-pack",
      name: "Render Pack",
      version: "0.1.0",
      crewcoder: { apiVersion: "0.1" },
      contributes: {
        ui: [{
          id: "audit-summary",
          title: "Audit Summary",
          kind: "renderer",
          target: "tool",
          match: { extensionId: "render-pack", toolId: "audit", renderer: "audit.summary" },
          template: "# Audit\n{{metadata.summary}}"
        }]
      }
    }, warnings)).not.toThrow();
    expect(warnings.some((warning) => warning.includes("renderers"))).toBe(true);
  });

  it("rejects malformed TUI renderer contributions", () => {
    expect(() => validateExtensionManifest({
      id: "bad-renderer", name: "Bad Renderer", version: "0.1.0", crewcoder: { apiVersion: "0.1" },
      contributes: { ui: [{ id: "broken", title: "Broken", kind: "renderer", target: "tool", match: {}, template: "x" }] }
    })).toThrow("renderer match");
  });

  it("accepts experimental live UI contract contributions", () => {
    const warnings: string[] = [];
    expect(() => validateExtensionManifest({
      id: "live-pack",
      name: "Live Pack",
      version: "0.1.0",
      crewcoder: { apiVersion: "0.1" },
      contributes: {
        liveUi: [{
          id: "review-panel",
          title: "Review Panel",
          experimental: true,
          entry: "ui/review-panel.ts",
          target: { surface: "modal", slot: "extension-ui" },
          activation: { events: ["extension_ui_request"], modes: ["tui"] },
          match: { eventTypes: ["extension_ui_request"], uiKinds: ["component"] },
          permissions: { ui: ["render", "input", "focus"], commands: ["ui_response"], clipboard: "none", storage: "none" }
        }]
      }
    }, warnings)).not.toThrow();
    expect(warnings.some((warning) => warning.includes("liveUi"))).toBe(true);
  });

  it("rejects live UI entries without the experimental marker", () => {
    expect(() => validateExtensionManifest({
      id: "bad-live", name: "Bad Live", version: "0.1.0", crewcoder: { apiVersion: "0.1" },
      contributes: {
        liveUi: [{
          id: "panel",
          title: "Panel",
          experimental: false,
          entry: "ui/panel.ts",
          target: { surface: "modal" },
          match: { eventTypes: ["extension_ui_request"] },
          permissions: { ui: ["render"] }
        }]
      }
    } as unknown as Parameters<typeof validateExtensionManifest>[0])).toThrow("experimental true");
  });

  it("rejects live UI entries that can escape the extension directory", () => {
    expect(() => validateExtensionManifest({
      id: "bad-live", name: "Bad Live", version: "0.1.0", crewcoder: { apiVersion: "0.1" },
      contributes: {
        liveUi: [{
          id: "panel",
          title: "Panel",
          experimental: true,
          entry: "../panel.ts",
          target: { surface: "modal" },
          match: { eventTypes: ["extension_ui_request"] },
          permissions: { ui: ["render"] }
        }]
      }
    })).toThrow("entry must stay inside");
  });

  it("rejects live UI entries without render permission", () => {
    expect(() => validateExtensionManifest({
      id: "bad-live", name: "Bad Live", version: "0.1.0", crewcoder: { apiVersion: "0.1" },
      contributes: {
        liveUi: [{
          id: "panel",
          title: "Panel",
          experimental: true,
          entry: "ui/panel.ts",
          target: { surface: "modal" },
          match: { eventTypes: ["extension_ui_request"] },
          permissions: { ui: ["input"] }
        }]
      }
    })).toThrow("permissions.ui must include render");
  });

  it("rejects unsupported live UI permission values", () => {
    expect(() => validateExtensionManifest({
      id: "bad-live", name: "Bad Live", version: "0.1.0", crewcoder: { apiVersion: "0.1" },
      contributes: {
        liveUi: [{
          id: "panel",
          title: "Panel",
          experimental: true,
          entry: "ui/panel.ts",
          target: { surface: "modal" },
          match: { uiKinds: ["component"] },
          permissions: { ui: ["render"], commands: ["shell"] }
        }]
      }
    } as unknown as Parameters<typeof validateExtensionManifest>[0])).toThrow("permissions.commands entries");
  });

  it("rejects live UI entries without match rules", () => {
    expect(() => validateExtensionManifest({
      id: "bad-live", name: "Bad Live", version: "0.1.0", crewcoder: { apiVersion: "0.1" },
      contributes: {
        liveUi: [{
          id: "panel",
          title: "Panel",
          experimental: true,
          entry: "ui/panel.ts",
          target: { surface: "modal" },
          match: {},
          permissions: { ui: ["render"] }
        }]
      }
    })).toThrow("match must include at least one matcher");
  });

  it("rejects unsupported live UI activation modes", () => {
    expect(() => validateExtensionManifest({
      id: "bad-live", name: "Bad Live", version: "0.1.0", crewcoder: { apiVersion: "0.1" },
      contributes: {
        liveUi: [{
          id: "panel",
          title: "Panel",
          experimental: true,
          entry: "ui/panel.ts",
          target: { surface: "modal" },
          activation: { modes: ["print"] },
          match: { eventTypes: ["extension_ui_request"] },
          permissions: { ui: ["render"] }
        }]
      }
    } as unknown as Parameters<typeof validateExtensionManifest>[0])).toThrow("activation.modes");
  });

  it("rejects malformed activation arrays", () => {
    expect(() => validateExtensionManifest({
      id: "bad", name: "Bad", version: "0.1.0", crewcoder: { apiVersion: "0.1" },
      activation: { keywords: ["ok", 42] as unknown as string[] }
    })).toThrow("activation.keywords");
  });
});

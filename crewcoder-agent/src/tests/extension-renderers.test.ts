import { describe, expect, it } from "vitest";
import { extensionRenderersFromManifest } from "../extensions/extension-renderers.js";
import type { LoadedCrewCoderExtension } from "../extensions/types.js";

function loadedExtension(manifest: LoadedCrewCoderExtension["manifest"]): LoadedCrewCoderExtension {
  return { dir: "/tmp/ext", manifest, warnings: [] };
}

describe("extension renderers", () => {
  it("normalizes declarative tool renderers from manifest UI contributions", () => {
    const renderers = extensionRenderersFromManifest(loadedExtension({
      id: "audit-pack",
      name: "Audit Pack",
      version: "0.1.0",
      crewcoder: { apiVersion: "0.1" },
      contributes: {
        ui: [{
          id: "summary",
          title: "Audit Summary",
          kind: "renderer",
          target: "tool",
          match: { extensionId: "audit-pack", toolId: "audit", renderer: "audit.summary" },
          template: "## Audit\n{{metadata.summary}}"
        }]
      }
    }));

    expect(renderers).toEqual([{
      extensionId: "audit-pack",
      id: "summary",
      title: "Audit Summary",
      target: "tool",
      match: { extensionId: "audit-pack", toolId: "audit", renderer: "audit.summary" },
      template: "## Audit\n{{metadata.summary}}"
    }]);
  });
});

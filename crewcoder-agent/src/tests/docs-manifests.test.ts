import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { embeddedCrewCoderExtensionDocs } from "../knowledge/crewcoder-extension-docs.js";
import { embeddedCrewCodeDocs } from "../knowledge/crewcode-docs.js";
import { validateExtensionManifest } from "../extensions/extension-loader.js";
import { validatePlugin } from "../tools/validate-plugin.js";

/**
 * The embedded docs teach the model what to write. If an example in them is invalid,
 * the agent confidently produces a manifest that CrewCoder itself rejects — and the
 * only symptom is a user hitting a validation error the docs caused.
 *
 * These tests run every JSON example in the doc bodies through the SAME validators the
 * product uses, so doc drift fails CI instead of shipping.
 */
function jsonBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

/** A block is a full manifest (not a `"contributes"` fragment) if it parses and has an id. */
function fullManifests(markdown: string): Array<Record<string, unknown>> {
  const manifests: Array<Record<string, unknown>> = [];
  for (const block of jsonBlocks(markdown)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue; // deliberate fragment, e.g. a bare "promptPacks": [...] snippet
    }
    if (parsed && typeof parsed === "object" && "id" in parsed) manifests.push(parsed as Record<string, unknown>);
  }
  return manifests;
}

describe("embedded doc examples", () => {
  it("every extension manifest example passes the real extension validator", () => {
    let checked = 0;
    for (const doc of embeddedCrewCoderExtensionDocs) {
      for (const manifest of fullManifests(doc.content ?? "")) {
        if (!("crewcoder" in manifest)) continue;
        checked++;
        expect(
          () => validateExtensionManifest(manifest as never, []),
          `doc "${doc.id}" contains an extension manifest CrewCoder would reject`
        ).not.toThrow();
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("every plugin manifest example passes the real plugin validator", () => {
    let checked = 0;
    for (const doc of embeddedCrewCodeDocs) {
      for (const manifest of fullManifests(doc.content ?? "")) {
        if (!("crewcode" in manifest)) continue;
        checked++;

        // validatePlugin works on a directory and checks that panel `entry` files
        // exist, so materialize the manifest plus stub entries for each panel.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-doc-plugin-"));
        fs.writeFileSync(path.join(dir, "crewcode.plugin.json"), JSON.stringify(manifest), "utf8");
        const contributes = (manifest.contributes ?? {}) as Record<string, Array<{ entry?: string }>>;
        for (const key of ["tabs", "sidebarPanels"]) {
          for (const entry of contributes[key] ?? []) {
            if (entry.entry) fs.writeFileSync(path.join(dir, entry.entry), "<!doctype html>", "utf8");
          }
        }

        const result = validatePlugin(dir);
        expect(result.errors, `doc "${doc.id}" contains a plugin manifest CrewCode would reject`).toEqual([]);
      }
    }
    expect(checked).toBeGreaterThan(3);
  });

  it("every fenced json block is either valid JSON or an intentional fragment", () => {
    for (const doc of [...embeddedCrewCoderExtensionDocs, ...embeddedCrewCodeDocs]) {
      for (const block of jsonBlocks(doc.content ?? "")) {
        const isFragment = block.trimStart().startsWith('"');
        if (isFragment) continue;
        expect(() => JSON.parse(block), `doc "${doc.id}" has a malformed json block`).not.toThrow();
      }
    }
  });
});

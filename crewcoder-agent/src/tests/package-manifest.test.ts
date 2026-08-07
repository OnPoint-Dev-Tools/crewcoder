import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("package manifest", () => {
  it("maps cc to the same CLI entrypoint as crewcoder", () => {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const manifest: unknown = JSON.parse(fs.readFileSync(packagePath, "utf8"));

    expect(manifest).toMatchObject({
      bin: {
        crewcoder: "./dist/cli.js",
        cc: "./dist/cli.js"
      }
    });
  });
});

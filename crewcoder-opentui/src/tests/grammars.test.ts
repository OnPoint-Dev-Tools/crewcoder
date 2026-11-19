import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { TreeSitterClient } from "@opentui/core";
import { afterAll, describe, expect, it } from "vitest";
import { BUNDLED_GRAMMARS, bundledParsers, GRAMMARS_DIR, highlightedFiletypes, registerBundledGrammars } from "../syntax/grammars.js";
import { codeFiletype, readOutputFiletype } from "../syntax/filetype.js";

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("bundled grammars", () => {
  it("ships the owner's language list", () => {
    expect(BUNDLED_GRAMMARS.map((entry) => entry.filetype).sort()).toEqual(["bash", "css", "go", "html", "json", "python", "rust", "yaml"]);
  });

  it.each(BUNDLED_GRAMMARS.map((entry) => [entry.filetype, entry] as const))("%s: files match their pinned hashes and keep the license", (filetype, entry) => {
    const dir = join(GRAMMARS_DIR, filetype);
    expect(entry.source.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sha256(join(dir, entry.wasm))).toBe(entry.sha256.wasm);
    expect(sha256(join(dir, "highlights.scm"))).toBe(entry.sha256.highlights);
    expect(readFileSync(join(dir, "LICENSE"), "utf8")).toMatch(/MIT License|Permission is hereby granted/);
  });

  it("points parsers at absolute local files, never URLs", () => {
    for (const parser of bundledParsers()) {
      for (const file of [parser.wasm, ...parser.queries.highlights]) {
        expect(isAbsolute(file)).toBe(true);
        expect(file).not.toMatch(/^https?:/);
        expect(existsSync(file)).toBe(true);
      }
    }
  });

  it("skips grammars whose files are missing", () => {
    expect(bundledParsers(mkdtempSync(join(tmpdir(), "no-grammars-")))).toEqual([]);
  });
});

describe("filetypes", () => {
  it("highlights only filetypes with a parser", () => {
    registerBundledGrammars();
    const supported = highlightedFiletypes();
    expect(codeFiletype("src/app.py", supported)).toBe("python");
    expect(codeFiletype("/x/main.go", supported)).toBe("go");
    expect(codeFiletype(".bashrc", supported)).toBe("bash");
    expect(codeFiletype("a.tsx", supported)).toBe("typescriptreact");
    expect(codeFiletype("Gemfile", supported)).toBeUndefined();
    expect(codeFiletype("a.rb", supported)).toBeUndefined();
    expect(codeFiletype("notes", supported)).toBeUndefined();
    expect(codeFiletype(undefined, supported)).toBeUndefined();
  });

  it("leaves line-numbered read output plain", () => {
    const supported = new Set(["python"]);
    expect(readOutputFiletype("a.py", "import os\n\nprint(os.getcwd())", supported)).toBe("python");
    expect(readOutputFiletype("a.py", "     1→import os\n     2→print(1)", supported)).toBeUndefined();
    expect(readOutputFiletype("a.py", "1\timport os\n2\tprint(1)", supported)).toBeUndefined();
    expect(readOutputFiletype("a.rb", "puts 1", supported)).toBeUndefined();
  });
});

// The real parser worker: proves each wasm loads under OpenTUI's web-tree-sitter
// and its highlight query compiles (a bad query would give no highlights).
describe("bundled grammars in OpenTUI's worker", () => {
  const client = new TreeSitterClient({ dataPath: mkdtempSync(join(tmpdir(), "crewcoder-ts-")) });
  afterAll(() => client.destroy());

  const SAMPLES: Readonly<Record<string, readonly [code: string, capture: string]>> = {
    python: ["def f(x):\n    return 'a'  # c\n", "keyword"],
    bash: ["if [ -f x ]; then echo \"$HOME\"; fi\n", "keyword"],
    json: ["{\"a\": [1, true, null]}\n", "number"],
    rust: ["fn main() { println!(\"{}\", 1); }\n", "function.macro"],
    go: ["package main\nfunc main() { x := \"s\"; _ = x }\n", "keyword"],
    yaml: ["a: 1\n# c\n", "comment"],
    css: [".a { color: #fff; }\n", "property"],
    html: ["<div class=\"a\"></div>\n", "tag"]
  };

  it("highlights every bundled language", async () => {
    for (const parser of bundledParsers()) client.addFiletypeParser(parser);
    await client.initialize();
    for (const entry of BUNDLED_GRAMMARS) {
      const [code, capture] = SAMPLES[entry.filetype]!;
      const result = await client.highlightOnce(code, entry.filetype);
      expect(result.error, entry.filetype).toBeUndefined();
      expect(result.highlights?.map((highlight) => highlight[2]), entry.filetype).toContain(capture);
    }
  }, 30_000);
});

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addDefaultParsers, type FiletypeParserOptions } from "@opentui/core";

/**
 * Tree-sitter grammars bundled with this package (owner decision 2026-11-18:
 * no runtime downloads). Each comes from the grammar's own npm package at an
 * exact version: its `.wasm`, its `queries/highlights.scm` (written for that
 * same grammar version), and its LICENSE, under `grammars/<filetype>/`.
 * `scripts/update-grammars.mjs` reproduces the files from this list and
 * `src/tests/grammars.test.ts` checks the hashes. Record changes in
 * THIRD_PARTY_NOTICES.md.
 */
export type BundledGrammar = {
  /** OpenTUI filetype, as `pathToFiletype` / `infoStringToFiletype` name it. */
  filetype: string;
  /** npm package and exact version the files come from. */
  source: { package: string; version: string };
  wasm: string;
  sha256: { wasm: string; highlights: string };
};

export const BUNDLED_GRAMMARS: readonly BundledGrammar[] = [
  grammar("python", "tree-sitter-python", "0.25.0", "16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47", "a6708f209381618e2b398972c8f1ccd892f0c064eab35a2a3f911c3e22e79a7e"),
  grammar("bash", "tree-sitter-bash", "0.25.1", "8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a", "b74220d954f485b7626d2b2b61f37b522e12eb1830803e388e57dd797dc99f11"),
  grammar("json", "tree-sitter-json", "0.24.8", "d2119fb98d5912719b13f9458574f8608d2d29dfbe45f6be1f860ea1fe2a2405", "0511524465b56aed122580792254e68b6abbbfde7119f1d02b135acbe278233f"),
  grammar("rust", "tree-sitter-rust", "0.24.0", "f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57", "0f0343107f14a7690157f51090a979eb8f8bfe4eada7c61763ddb4c54b1311d1"),
  grammar("go", "tree-sitter-go", "0.25.0", "9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7", "81182c986547eba7fa6316e82dfd621fb13b8fc89efac85432aee51a48ed0896"),
  grammar("yaml", "@tree-sitter-grammars/tree-sitter-yaml", "0.7.1", "e752dc21c3591df9b45692fe417d101f45d1828c28c44d79005f4066dc7e4e91", "2fbfbbd5ca0928d0a7e09e59f8f2964b14a328a7ee0ce799270d9013dcce49a0"),
  grammar("css", "tree-sitter-css", "0.25.0", "8a23977fe271357cce6f254ef88c9bebf3854602d8046605aef6a45c02135c59", "23f7948a3817a0d06d7120158c3bee4ec5b58daa77e524985a4738b364db17b2"),
  grammar("html", "tree-sitter-html", "0.23.2", "c48fcd82c7ea8bf943180088ba7f28c48b2bb5287874179168bf9d31e394cf85", "1ebb3811a8cdc054385b847a3aac6fbf7079faefd5b3dfab5bbad256cd5afdcf")
];

/** Filetypes OpenTUI 0.9.2 ships parsers for (`lib/tree-sitter/default-parsers`). */
const OPENTUI_FILETYPES = ["javascript", "javascriptreact", "typescript", "typescriptreact", "markdown", "zig"] as const;

/** `grammars/` next to `src/` and `dist/`: both compile one level under the package root. */
export const GRAMMARS_DIR = fileURLToPath(new URL("../../grammars/", import.meta.url));

/**
 * Parser options for the bundled grammars that are present, with absolute
 * local paths (OpenTUI resolves relative paths against the process cwd and
 * would fetch a URL with no integrity check). A missing grammar is skipped,
 * so its filetype renders as plain text.
 */
export function bundledParsers(dir: string = GRAMMARS_DIR): FiletypeParserOptions[] {
  return BUNDLED_GRAMMARS.flatMap((entry) => {
    const wasm = join(dir, entry.filetype, entry.wasm);
    const highlights = join(dir, entry.filetype, "highlights.scm");
    if (!existsSync(wasm) || !existsSync(highlights)) return [];
    return [{ filetype: entry.filetype, wasm, queries: { highlights: [highlights] } }];
  });
}

let registered: ReadonlySet<string> | undefined;

/**
 * Adds the bundled grammars to OpenTUI's default parsers. Call once before the
 * first highlight: the Tree-sitter client reads the list when its worker starts.
 */
export function registerBundledGrammars(dir: string = GRAMMARS_DIR): void {
  const parsers = bundledParsers(dir);
  addDefaultParsers(parsers);
  registered = new Set(parsers.map((parser) => parser.filetype));
}

/** Filetypes that highlight: OpenTUI's own plus the registered bundled grammars. */
export function highlightedFiletypes(): ReadonlySet<string> {
  return new Set<string>([...OPENTUI_FILETYPES, ...(registered ?? [])]);
}

function grammar(filetype: string, pkg: string, version: string, wasmSha: string, highlightsSha: string): BundledGrammar {
  const name = pkg.split("/").pop() ?? pkg;
  return { filetype, source: { package: pkg, version }, wasm: `${name}.wasm`, sha256: { wasm: wasmSha, highlights: highlightsSha } };
}

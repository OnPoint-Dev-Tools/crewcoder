#!/usr/bin/env node
// Reproduces grammars/<filetype>/ from the pinned npm packages: each grammar's
// own .wasm, queries/highlights.scm, and LICENSE. Prints the sha256 values for
// BUNDLED_GRAMMARS in src/syntax/grammars.ts; src/tests/grammars.test.ts fails
// until they match. Run by hand when bumping a grammar; never at install time.
//
//   node scripts/update-grammars.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Keep in sync with BUNDLED_GRAMMARS (filetype, package, exact version). */
const GRAMMARS = [
  ["python", "tree-sitter-python", "0.25.0"],
  ["bash", "tree-sitter-bash", "0.25.1"],
  ["json", "tree-sitter-json", "0.24.8"],
  ["rust", "tree-sitter-rust", "0.24.0"],
  ["go", "tree-sitter-go", "0.25.0"],
  ["yaml", "@tree-sitter-grammars/tree-sitter-yaml", "0.7.1"],
  ["css", "tree-sitter-css", "0.25.0"],
  ["html", "tree-sitter-html", "0.23.2"]
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "grammars");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

for (const [filetype, pkg, version] of GRAMMARS) {
  // Each tarball unpacks in its own empty directory; nothing from it is executed.
  const work = mkdtempSync(join(tmpdir(), `grammar-${filetype}-`));
  const tarball = execFileSync("npm", ["pack", "--silent", "--ignore-scripts", `${pkg}@${version}`], { cwd: work, encoding: "utf8" }).trim();
  execFileSync("tar", ["xzf", tarball, "package/LICENSE", "package/queries/highlights.scm", `package/${wasmName(pkg)}`], { cwd: work });
  const out = join(root, filetype);
  mkdirSync(out, { recursive: true });
  copyFileSync(join(work, "package", wasmName(pkg)), join(out, wasmName(pkg)));
  copyFileSync(join(work, "package", "queries", "highlights.scm"), join(out, "highlights.scm"));
  copyFileSync(join(work, "package", "LICENSE"), join(out, "LICENSE"));
  console.log(`${filetype} ${pkg}@${version} wasm=${sha256(join(out, wasmName(pkg)))} highlights=${sha256(join(out, "highlights.scm"))}`);
}
console.log(`grammars/: ${readdirSync(root).length} languages`);

function wasmName(pkg) {
  return `${pkg.split("/").pop()}.wasm`;
}

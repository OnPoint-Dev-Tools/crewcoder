#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const baseline = path.join(root, "api");
const update = process.argv.includes("--update");

if (!fs.existsSync(dist)) {
  console.error("SDK dist directory is missing. Run npm run build first.");
  process.exit(1);
}

const declarations = listDeclarations(dist);
if (!declarations.length) {
  console.error("SDK build emitted no declaration files.");
  process.exit(1);
}

if (update) {
  fs.rmSync(baseline, { recursive: true, force: true });
  for (const relative of declarations) {
    const target = path.join(baseline, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(dist, relative), target);
  }
  console.log(`Updated SDK API baseline (${declarations.length} declaration files).`);
  process.exit(0);
}

if (!fs.existsSync(baseline)) {
  console.error("SDK API baseline is missing. Run npm run api:update after reviewing the public contract.");
  process.exit(1);
}

const expected = listDeclarations(baseline);
const differences = [];
for (const relative of new Set([...declarations, ...expected])) {
  const actualFile = path.join(dist, relative);
  const expectedFile = path.join(baseline, relative);
  if (!fs.existsSync(actualFile)) differences.push(`removed: ${relative}`);
  else if (!fs.existsSync(expectedFile)) differences.push(`added: ${relative}`);
  else if (fs.readFileSync(actualFile, "utf8") !== fs.readFileSync(expectedFile, "utf8")) differences.push(`changed: ${relative}`);
}

if (differences.length) {
  console.error("CrewCoder SDK public API changed:");
  for (const difference of differences) console.error(`  ${difference}`);
  console.error("Review the change, apply semver policy, then run npm run api:update.");
  process.exit(1);
}
console.log(`SDK API compatibility check passed (${declarations.length} declaration files).`);

function listDeclarations(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".d.ts")) files.push(path.relative(directory, absolute));
    }
  };
  visit(directory);
  return files.sort();
}

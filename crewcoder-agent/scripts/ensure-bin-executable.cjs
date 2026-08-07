const fs = require("node:fs");
const path = require("node:path");

const binPath = path.join(__dirname, "..", "dist", "cli.js");

if (!fs.existsSync(binPath)) {
  console.warn(`[crewcoder] bin file not found yet: ${binPath}`);
  process.exit(0);
}

let text = fs.readFileSync(binPath, "utf8");

if (!text.startsWith("#!/usr/bin/env node")) {
  text = "#!/usr/bin/env node\n" + text;
  fs.writeFileSync(binPath, text, "utf8");
}

try {
  fs.chmodSync(binPath, 0o755);
  console.log(`[crewcoder] executable bit set: ${binPath}`);
} catch (error) {
  console.warn(`[crewcoder] failed to chmod ${binPath}: ${error.message}`);
}

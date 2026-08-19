#!/usr/bin/env node
import { runCrewCoder } from "../lib/launcher.js";

try {
  process.exitCode = await runCrewCoder(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`crewcoder: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

#!/usr/bin/env node
import { existsSync } from "node:fs";

const entry = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(entry)) {
  console.error("The latticeag CLI has not been built. Run pnpm build from the workspace root.");
  process.exitCode = 1;
} else {
  await import(entry.href);
}

#!/usr/bin/env node
// Checked-in launcher for the `latticeag` bin. pnpm refuses to link a bin
// whose target file does not exist, so pointing `bin` at dist/cli.js meant
// `pnpm install` before `pnpm build` warned "Failed to create bin" and left
// the command unlinked until a second install. This file exists at install
// time, so the link always succeeds; it delegates to the built entrypoint.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(here, "../dist/cli.js");

if (!existsSync(distEntry)) {
  console.error(
    "latticeag is not built yet — run `pnpm build` from the repo root, then retry.",
  );
  process.exit(1);
}

await import(pathToFileURL(distEntry).href);

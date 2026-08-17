import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { latticeagConfigJsonSchema } from "./json-schema.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const out = path.join(repoRoot, "schemas", "latticeag-config-v1.schema.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(latticeagConfigJsonSchema(), null, 2)}\n`);

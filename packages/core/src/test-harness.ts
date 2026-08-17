import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LatticeAG } from "./lattice.js";
import type { LatticeAGCreateOptions } from "./types.js";

export const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

export function cleanEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...extra };
  delete env.LATTICEAG_CONFIG;
  return env;
}

export async function tmpProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lg-core-"));
  await mkdir(join(dir, ".latticeag"), { recursive: true });
  await writeFile(join(dir, "latticeag.json"), await readFile(join(FIXTURES, "latticeag.json")));
  return dir;
}

export async function createFixtureLattice(extra?: LatticeAGCreateOptions) {
  const dir = extra?.cwd ?? (await tmpProject());
  const lattice = await LatticeAG.create({
    ...extra,
    cwd: dir,
    configPath: extra?.configPath ?? join(dir, "latticeag.json"),
    env: cleanEnv(extra?.env),
    fixtures: {
      beliefs: join(FIXTURES, "beliefs.json"),
      verdicts: join(FIXTURES, "verdicts.json"),
      approvals: join(FIXTURES, "approvals.json"),
      receipts: join(FIXTURES, "receipts.json"),
      ...extra?.fixtures,
    },
    stages: {
      inspect: { backend: "fixture" },
      verify: { backend: "fixture" },
      approve: { backend: "fixture" },
      receipt: { backend: "fixture" },
      record: { backend: "local" },
      ...extra?.stages,
    },
  });
  return { dir, lattice };
}

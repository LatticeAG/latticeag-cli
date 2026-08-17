import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const V2_FIXTURE = {
  kind: "latticeag.viscompile.transcript",
  schema_version: 2,
  cases: [
    {
      id: "cap-probe",
      input: { prompt: "probe" },
      events: [
        {
          type: "belief",
          belief_type: "assumption",
          text: "staging shares prod credentials",
          confidence: 0.5,
          id: "belief-assumption-1",
        },
        {
          type: "final",
          output: {},
        },
      ],
    },
  ],
};

export type ViscompileCapCache = Record<string, boolean>;

export function capCachePath(cwd = process.cwd()): string {
  return path.join(cwd, ".latticeag", "viscompile-cap.json");
}

export function readCapCache(filePath: string): ViscompileCapCache {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }
    const out: ViscompileCapCache = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "boolean") {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeCapCache(
  filePath: string,
  cache: ViscompileCapCache,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(cache, null, 2)}\n`);
}

async function latticeVersion(bin: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return `${result.stdout}${result.stderr}`.trim();
  } catch {
    return undefined;
  }
}

/**
 * Probe whether `lattice compile` accepts a schema_version 2 belief event.
 * Caches the result in `.latticeag/viscompile-cap.json` keyed by `lattice --version` stdout.
 */
export async function supportsBeliefs(bin: string): Promise<boolean> {
  const version = await latticeVersion(bin);
  if (version === undefined) {
    return false;
  }
  const filePath = capCachePath();
  const cache = readCapCache(filePath);
  if (Object.prototype.hasOwnProperty.call(cache, version)) {
    return cache[version] === true;
  }

  const dir = mkdtempSync(path.join(tmpdir(), "latticeag-viscompile-cap-"));
  const inputPath = path.join(dir, "probe.v2.json");
  const outPath = path.join(dir, "probe.out.json");
  writeFileSync(inputPath, `${JSON.stringify(V2_FIXTURE)}\n`);

  let ok = false;
  try {
    await execFileAsync(bin, ["compile", "--input", inputPath, "--out", outPath], {
      encoding: "utf8",
      timeout: 30_000,
    });
    ok = true;
  } catch {
    ok = false;
  }

  cache[version] = ok;
  writeCapCache(filePath, cache);
  return ok;
}

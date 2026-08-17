import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export interface ChainEvent {
  name: string;
  seq: number;
  message?: string;
}

export const PRODUCTION_CONFIG = "env: production\nreplicas: 3\n";
export const LATTICE_NOT_FOUND = "lattice binary not found";

export function parseJsonl(filePath: string): ChainEvent[] {
  if (!existsSync(filePath)) {
    throw new Error(`events jsonl not found: ${filePath}`);
  }
  const text = readFileSync(filePath, "utf8");
  const events: ChainEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const parsed = JSON.parse(line) as {
      name?: unknown;
      seq?: unknown;
      payload?: { message?: unknown };
    };
    if (typeof parsed.name === "string" && typeof parsed.seq === "number") {
      const event: ChainEvent = { name: parsed.name, seq: parsed.seq };
      if (typeof parsed.payload?.message === "string") {
        event.message = parsed.payload.message;
      }
      events.push(event);
    }
  }
  return events;
}

export function firstSeq(events: ChainEvent[], name: string): number | undefined {
  return events.find((event) => event.name === name)?.seq;
}

export function latticeOnPath(): boolean {
  try {
    execFileSync("lattice", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

export interface AssertResult {
  ok: boolean;
  lines: string[];
  names: string[];
}

export function assertChain(
  events: ChainEvent[],
  configYaml: string,
  opts: { latticePresent: boolean; allowMissingDiff: boolean },
): AssertResult {
  const names = events.map((event) => event.name);
  const lines: string[] = [];
  let ok = true;
  for (const name of [
    "belief_extracted",
    "verdict",
    "approval_granted",
    "receipt_issued",
  ]) {
    if (!names.includes(name)) {
      ok = false;
      lines.push(`missing ${name}`);
    }
  }
  const belief = firstSeq(events, "belief_extracted");
  const verdict = firstSeq(events, "verdict");
  const approval = firstSeq(events, "approval_granted");
  const receipt = firstSeq(events, "receipt_issued");
  if (
    belief === undefined ||
    verdict === undefined ||
    approval === undefined ||
    receipt === undefined ||
    !(belief < verdict && verdict < approval && approval < receipt)
  ) {
    ok = false;
    lines.push(
      `order failed: belief=${belief ?? "-"} verdict=${verdict ?? "-"} approval=${approval ?? "-"} receipt=${receipt ?? "-"}`,
    );
  } else {
    lines.push(
      `order ok: belief=${belief} < verdict=${verdict} < approval=${approval} < receipt=${receipt}`,
    );
  }
  if (configYaml !== PRODUCTION_CONFIG) {
    ok = false;
    lines.push("out/config.yaml is not the production file");
  } else {
    lines.push("out/config.yaml matches production");
  }
  if (opts.latticePresent) {
    if (!names.includes("diff_computed")) {
      ok = false;
      lines.push("missing diff_computed (lattice is on PATH)");
    } else {
      lines.push("diff_computed present");
    }
  } else if (opts.allowMissingDiff) {
    lines.push("lattice missing; LATTICEAG_ALLOW_MISSING_DIFF=1");
  } else {
    const hit = events.some(
      (event) =>
        event.name === "adapter_error" &&
        (event.message ?? "").includes(LATTICE_NOT_FOUND),
    );
    if (!hit) {
      ok = false;
      lines.push(`missing adapter_error containing ${LATTICE_NOT_FOUND}`);
    } else {
      lines.push(`adapter_error contains ${LATTICE_NOT_FOUND}`);
    }
  }
  lines.push(`names: ${names.join(", ")}`);
  return { ok, lines, names };
}

export function runAssertChain(jsonlPath: string, cwd = process.cwd()): AssertResult {
  const events = parseJsonl(jsonlPath);
  const configPath = path.join(cwd, "out", "config.yaml");
  const configYaml = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : "";
  return assertChain(events, configYaml, {
    latticePresent: latticeOnPath(),
    allowMissingDiff: process.env.LATTICEAG_ALLOW_MISSING_DIFF === "1",
  });
}

const invoked = process.argv[1] ? path.basename(process.argv[1]) : "";
if (invoked === "assert-chain.ts" || invoked === "assert-chain.js") {
  const jsonl =
    process.argv[2] ?? path.join(process.cwd(), ".latticeag", "events.jsonl");
  const result = runAssertChain(jsonl);
  process.stdout.write(`${result.lines.join("\n")}\n`);
  process.exit(result.ok ? 0 : 1);
}

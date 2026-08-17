import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AnyLatticeEvent } from "@latticeag/events";
import { DUMMY_ADAPTER_ENV, initRunProject, runCli } from "../test-spawn.js";
import { formatTextEvent, summarizeEvent } from "./events-summary.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "latticeag-events-"));
}

const eventsFixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../events/fixtures/belief_extracted.json",
);

describe("latticeag events", () => {
  it("--follow + --format json exits 1", async () => {
    const result = await runCli(["events", "--follow", "--format", "json"]);
    expect(result.status).toBe(1);
    expect(`${result.stderr}${result.stdout}`).toMatch(
      /incompatible with --follow/,
    );
  });

  it("empty log prints 0 events on stderr", async () => {
    const dir = tempDir();
    const init = await runCli(["init", dir, "--template", "blank", "--force"], {
      env: DUMMY_ADAPTER_ENV,
    });
    expect(init.status).toBe(0);
    const result = await runCli(["--cwd", dir, "events"], {
      env: DUMMY_ADAPTER_ENV,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("0 events");
  });

  it("after a run, --format json --limit 20 is a JSON array", async () => {
    const dir = tempDir();
    await initRunProject(dir);
    const run = await runCli(
      [
        "--cwd",
        dir,
        "run",
        "--attach",
        "custom",
        "--cmd",
        "node src/agent.ts",
        "--json",
      ],
      { env: DUMMY_ADAPTER_ENV },
    );
    expect(run.status, run.stderr + run.stdout).toBe(0);
    const result = await runCli(
      ["--cwd", dir, "events", "--format", "json", "--limit", "20"],
      { env: DUMMY_ADAPTER_ENV },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const parsed = JSON.parse(result.stdout) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("text summary for belief_extracted matches spec columns", () => {
    const event = JSON.parse(readFileSync(eventsFixture, "utf8")) as AnyLatticeEvent;
    expect(summarizeEvent(event)).toBe(
      "assumption 0.50  staging shares prod credentials",
    );
    expect(formatTextEvent(event)).toBe(
      "2026-08-17T13:57:00.123Z  00001  belief_extracted  axion  assumption 0.50  staging shares prod credentials",
    );
  });

  it("--replay dumps a JSONL file as a JSON array", async () => {
    const dir = tempDir();
    const parsedFixture = JSON.parse(readFileSync(eventsFixture, "utf8"));
    const replay = path.join(dir, "events.jsonl");
    writeFileSync(replay, `${JSON.stringify(parsedFixture)}\n`);
    const result = await runCli([
      "events",
      "--replay",
      replay,
      "--format",
      "json",
      "--limit",
      "20",
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as AnyLatticeEvent[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe("belief_extracted");
  });
});

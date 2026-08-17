import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DUMMY_ADAPTER_ENV, initRunProject, runCli } from "../test-spawn.js";
import {
  isUnsupportedPlatform,
  WINDOWS_UNSUPPORTED,
} from "./run.js";
import { hermesKit } from "../attach/hermes.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "latticeag-run-"));
}

describe("windows platform guard", () => {
  it("treats win32 as unsupported and exposes the spec message", () => {
    expect(isUnsupportedPlatform("win32")).toBe(true);
    expect(isUnsupportedPlatform("linux")).toBe(false);
    expect(isUnsupportedPlatform("darwin")).toBe(false);
    expect(WINDOWS_UNSUPPORTED).toBe(
      "latticeag run does not support windows in v0.1",
    );
  });

  it("stubs process.platform via the helper", () => {
    expect(isUnsupportedPlatform("win32")).toBe(true);
    expect(isUnsupportedPlatform(process.platform)).toBe(
      process.platform === "win32",
    );
  });
});

describe("attach kits", () => {
  it("hermes detect is true when argv basename is hermes or HERMES_HOME is set", () => {
    expect(hermesKit.detect({}, ["hermes"])).toBe(true);
    expect(hermesKit.detect({}, ["/usr/bin/hermes"])).toBe(true);
    expect(hermesKit.detect({ HERMES_HOME: "/opt/hermes" }, ["node"])).toBe(
      true,
    );
    expect(hermesKit.detect({}, ["node"])).toBe(false);
  });
});

describe("latticeag run", () => {
  it("runs a hello agent with --attach custom --json", async () => {
    const dir = tempDir();
    await initRunProject(dir);
    const result = await runCli(
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
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      data: { child_exit: number; event_count: number; run_id: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("run");
    expect(envelope.data.child_exit).toBe(0);
    expect(envelope.data.run_id.length).toBeGreaterThan(0);
  });

  it("dev without a TTY exits 1 with the split-command message", async () => {
    const result = await runCli(["dev", "--cmd", "node -e 0"]);
    expect(result.status).toBe(1);
    expect(`${result.stderr}${result.stdout}`).toContain(
      'latticeag dev needs a TTY. Use latticeag run --cmd "..." and latticeag events --follow --format ndjson',
    );
  });
});

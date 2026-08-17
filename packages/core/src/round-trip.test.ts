import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { LatticeAG } from "./lattice.js";
import { StageDisabledError, StageNotImplementedError } from "./errors.js";
import { createFixtureLattice, FIXTURES, cleanEnv } from "./test-harness.js";

export async function roundTrip(): Promise<{ dir: string; text: string }> {
  const dir = await mkdtemp(join(tmpdir(), "lg-core-"));
  await mkdir(join(dir, ".latticeag"), { recursive: true });
  await writeFile(
    join(dir, "latticeag.json"),
    await readFile(new URL("../fixtures/latticeag.json", import.meta.url)),
  );
  const lattice = await LatticeAG.create({
    cwd: dir,
    env: cleanEnv(),
    configPath: join(dir, "latticeag.json"),
    fixtures: {
      beliefs: fileURLToPath(new URL("../fixtures/beliefs.json", import.meta.url)),
      verdicts: fileURLToPath(new URL("../fixtures/verdicts.json", import.meta.url)),
      approvals: fileURLToPath(new URL("../fixtures/approvals.json", import.meta.url)),
      receipts: fileURLToPath(new URL("../fixtures/receipts.json", import.meta.url)),
    },
    stages: {
      inspect: { backend: "fixture" },
      verify: { backend: "fixture" },
      approve: { backend: "fixture" },
      receipt: { backend: "fixture" },
      record: { backend: "local" },
    },
  });
  const beliefs = await lattice.inspect({ source: "fixture" });
  if (beliefs.length < 1) throw new Error("expected beliefs");
  const first = await lattice.observeTool({
    source: "visreplay",
    name: "write_file",
    arguments: { path: "out/config.yaml", contents: "env: staging\nreplicas: 3\n" },
    result: { ok: true },
  });
  const steer = await lattice.verify({
    causation_id: first.id,
    name: "write_file",
    arguments: first.payload.arguments,
    result: first.payload.result,
  });
  if (steer.payload.verdict !== "steer") throw new Error("expected steer");
  const second = await lattice.observeTool({
    source: "visreplay",
    name: "write_file",
    arguments: { path: "out/config.yaml", contents: "env: production\nreplicas: 3\n" },
    result: { ok: true },
  });
  const pass = await lattice.verify({
    causation_id: second.id,
    name: "write_file",
    arguments: second.payload.arguments,
    result: second.payload.result,
  });
  if (pass.payload.verdict !== "pass") throw new Error("expected pass");
  const granted = await lattice.approve({ causation_id: steer.id, source: "verdict" });
  await lattice.receipt({
    request_id: granted.payload.request_id,
    action: "write_file",
    payload_bytes: new TextEncoder().encode("env: production\nreplicas: 3\n"),
  });
  class Dummy {
    async noop() {
      return 1;
    }
  }
  lattice.wrap(new Dummy());
  await lattice.record();
  await lattice.close();
  const text = await readFile(join(dir, ".latticeag/events.jsonl"), "utf8");
  const result = LatticeAG.digest(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return { dir, text };
}

function includesSubsequence(names: string[], required: string[]): boolean {
  let index = 0;
  for (const name of names) {
    if (name === required[index]) {
      index += 1;
      if (index === required.length) {
        return true;
      }
    }
  }
  return false;
}

describe("round-trip", () => {
  test("spec section 22 flow digest ok and required subsequence", async () => {
    const { text } = await roundTrip();
    const result = LatticeAG.digest(text);
    expect(result.ok).toBe(true);
    const expected = JSON.parse(
      await readFile(join(FIXTURES, "expected-chain.names.json"), "utf8"),
    ) as { required_subsequence: string[] };
    const names = result.events.map((event) => event.name);
    expect(includesSubsequence(names, expected.required_subsequence)).toBe(true);
    expect(text).not.toContain("sk-");
    expect(text).not.toContain("vk_live_");
  });

  test("shield throws STAGE_DISABLED, compensate/breakLoop STAGE_NOT_IMPLEMENTED", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      await expect(lattice.shield({ tool: "write_file" })).rejects.toBeInstanceOf(StageDisabledError);
      await expect(
        lattice.compensate({
          request_id: "req-1",
          execution_id: "exec-1",
          action: "revert",
          state_to: "executed",
        }),
      ).rejects.toBeInstanceOf(StageNotImplementedError);
      await expect(lattice.breakLoop({ window: [{ name: "write_file" }] })).rejects.toBeInstanceOf(
        StageNotImplementedError,
      );
    } finally {
      await lattice.close();
    }
  });

  test("lattice.ts has no run( method", async () => {
    const src = await readFile(new URL("./lattice.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s+run\(/m);
  });
});

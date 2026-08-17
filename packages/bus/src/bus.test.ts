import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AnyLatticeEvent } from "@latticeag/events";
import { LatticeBus, type BusOptions, type EmitPartial } from "./bus.js";
import { newEnvelopeId, newRunId, newSessionId } from "./ids.js";
import { createJsonlWatcher } from "./watch.js";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const INTERNAL = {
  product: "latticeag" as const,
  adapter: "latticeag-internal",
  adapter_version: "0.1.0",
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "latticeag-bus-"));
}

function testOptions(dir: string, extra: Partial<BusOptions> = {}): BusOptions {
  return {
    run_id: newRunId(),
    session_id: extra.session_id ?? newSessionId(),
    log_path: join(dir, "events.jsonl"),
    ring_capacity: 10000,
    overflow_block_ms: 10,
    overflow: "drop",
    persist_fail: "throw",
    redact_keys: [],
    include_raw_text: false,
    max_log_bytes: 268435456,
    ...extra,
  };
}

function ext(
  payload: Record<string, unknown> = {},
): EmitPartial<"extension"> {
  return {
    name: "extension",
    producer: INTERNAL,
    correlation_id: newEnvelopeId(),
    payload: {
      extension_name: "bus.test",
      payload,
    },
  };
}

function readLog(path: string): AnyLatticeEvent[] {
  const text = readFileSync(path, "utf8");
  if (text.length === 0) {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AnyLatticeEvent);
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timeout waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const buses: LatticeBus[] = [];

function openBus(options: BusOptions): LatticeBus {
  const bus = new LatticeBus(options);
  buses.push(bus);
  return bus;
}

afterEach(async () => {
  const pending = buses.splice(0);
  await Promise.all(pending.map((bus) => bus.close()));
});

describe("LatticeBus", () => {
  it("emit assigns seq 1 then 2", async () => {
    const dir = tempDir();
    const bus = openBus(testOptions(dir));
    const first = await bus.emit(ext({ n: 1 }));
    const second = await bus.emit(ext({ n: 2 }));
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(bus.seq()).toBe(2);
  });

  it("JSONL roundtrip equals in-memory", async () => {
    const dir = tempDir();
    const options = testOptions(dir);
    const bus = openBus(options);
    const first = await bus.emit(ext({ n: 1 }));
    const second = await bus.emit(ext({ n: 2 }));
    const lines = readLog(options.log_path);
    expect(lines).toEqual([first, second]);
  });

  it("subscriber throw emits adapter_error and continues", async () => {
    const dir = tempDir();
    const options = testOptions(dir);
    const bus = openBus(options);
    bus.subscribe("extension", () => {
      throw new Error("subscriber failed");
    });
    const first = await bus.emit(ext({ n: 1 }));
    const second = await bus.emit(ext({ n: 2 }));
    expect(first.seq).toBe(1);
    expect(second.seq).toBeGreaterThan(first.seq);
    await waitUntil(() => readLog(options.log_path).some((e) => e.name === "adapter_error"));
    const names = readLog(options.log_path).map((e) => e.name);
    expect(names).toContain("adapter_error");
    expect(names.filter((n) => n === "extension").length).toBeGreaterThanOrEqual(2);
    const err = readLog(options.log_path).find((e) => e.name === "adapter_error");
    expect(err?.producer).toEqual(INTERNAL);
    expect(err?.payload).toMatchObject({
      adapter: "latticeag-internal",
      message: "subscriber failed",
    });
  });

  it("capacity 2 overflow drop", async () => {
    const dir = tempDir();
    const options = testOptions(dir, {
      ring_capacity: 2,
      overflow: "drop",
      overflow_block_ms: 5000,
    });
    const bus = openBus(options);
    await bus.emit(ext({ n: 1 }));
    await bus.emit(ext({ n: 2 }));
    const t0 = Date.now();
    const third = await bus.emit(ext({ n: 3 }));
    expect(Date.now() - t0).toBeLessThan(1000);
    const lines = readLog(options.log_path);
    const overflow = lines.find((e) => e.name === "bus_overflow");
    expect(overflow).toBeDefined();
    expect(overflow?.payload).toMatchObject({
      reason: "capacity",
      dropped_id: third.id,
      dropped_name: "extension",
      ring_size: 2,
      ring_capacity: 2,
    });
  });

  it("serializes concurrent emit", async () => {
    const dir = tempDir();
    const bus = openBus(testOptions(dir));
    const emitted = await Promise.all(
      Array.from({ length: 50 }, (_, i) => bus.emit(ext({ i }))),
    );
    const seqs = emitted.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(emitted.map((e) => e.id)).size).toBe(50);
    expect(new Set(emitted.map((e) => e.seq)).size).toBe(50);
  });

  it("blocks then drops at capacity", async () => {
    const dir = tempDir();
    const options = testOptions(dir, {
      ring_capacity: 2,
      overflow: "block_then_drop",
      overflow_block_ms: 40,
    });
    const bus = openBus(options);
    await bus.emit(ext({ n: 1 }));
    await bus.emit(ext({ n: 2 }));
    const t0 = Date.now();
    const third = await bus.emit(ext({ n: 3 }));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    const overflow = readLog(options.log_path).find((e) => e.name === "bus_overflow");
    expect(overflow?.payload).toMatchObject({
      reason: "capacity",
      dropped_id: third.id,
      dropped_name: "extension",
      ring_size: 2,
      ring_capacity: 2,
    });
  });

  it("replay from seq", async () => {
    const dir = tempDir();
    const options = testOptions(dir);
    const bus = openBus(options);
    await bus.emit(ext({ n: 1 }));
    await bus.emit(ext({ n: 2 }));
    await bus.emit(ext({ n: 3 }));
    const seen: AnyLatticeEvent[] = [];
    for await (const event of bus.replay(options.log_path, 2)) {
      seen.push(event);
    }
    expect(seen.map((e) => e.seq)).toEqual([2, 3]);
    expect(seen.every((e) => e.name === "extension")).toBe(true);
  });

  it("watch sees event from another LatticeBus in a child process", async () => {
    const dir = tempDir();
    const logPath = join(dir, "events.jsonl");
    writeFileSync(logPath, "");
    const seen: AnyLatticeEvent[] = [];
    const watcher = createJsonlWatcher(logPath, (event) => {
      seen.push(event);
    });
    const childFile = join(here, "watch.child.ts");
    const tsx = require.resolve("tsx");
    const child = spawn(
      process.execPath,
      ["--import", tsx, childFile, logPath, newRunId(), newSessionId()],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      const code: number | null = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (exitCode) => resolve(exitCode));
      });
      expect(code, stderr).toBe(0);
      await waitUntil(() => seen.length >= 1, 8000);
      expect(seen[0]?.name).toBe("extension");
      expect(seen[0]?.payload).toMatchObject({
        extension_name: "watch.ping",
        payload: { ok: true },
      });
    } finally {
      watcher.close();
      if (!child.killed) {
        child.kill();
      }
    }
  }, 15000);
});

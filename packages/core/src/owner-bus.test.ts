import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REDACT_KEYS } from "@latticeag/events";
import { describe, expect, test } from "vitest";
import { LatticeBus } from "./owner-bus.js";
import type { BusOptions } from "./types.js";

const PRODUCER = {
  product: "axion" as const,
  adapter: "@latticeag/adapter-axion",
  adapter_version: "0.1.0",
};

async function tmpBus(
  overrides?: Partial<BusOptions>,
): Promise<{ bus: LatticeBus; log_path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "lg-bus-"));
  const log_path = join(dir, "events.jsonl");
  const bus = new LatticeBus({
    run_id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
    session_id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    log_path,
    ring_capacity: 100,
    overflow_block_ms: 0,
    overflow: "drop",
    persist_fail: "throw",
    redact_keys: [...DEFAULT_REDACT_KEYS],
    include_raw_text: false,
    max_log_bytes: 268435456,
    ...overrides,
  });
  return { bus, log_path };
}

describe("LatticeBus", () => {
  test("emit assigns seq 1 then 2", async () => {
    const { bus } = await tmpBus();
    const first = await bus.emit({
      name: "tool_observed",
      payload: { source: "visreplay", name: "write_file", arguments: { path: "a" } },
      producer: PRODUCER,
      correlation_id: bus.run_id,
    });
    const second = await bus.emit({
      name: "tool_observed",
      payload: { source: "visreplay", name: "write_file", arguments: { path: "b" } },
      producer: PRODUCER,
      correlation_id: bus.run_id,
    });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    await bus.close();
  });

  test("subscriber throw emits adapter_error and continues", async () => {
    const { bus, log_path } = await tmpBus();
    bus.subscribe("tool_observed", () => {
      throw new Error("subscriber boom");
    });
    const first = await bus.emit({
      name: "tool_observed",
      payload: { source: "visreplay", name: "one", arguments: {} },
      producer: PRODUCER,
      correlation_id: bus.run_id,
    });
    const second = await bus.emit({
      name: "tool_observed",
      payload: { source: "visreplay", name: "two", arguments: {} },
      producer: PRODUCER,
      correlation_id: bus.run_id,
    });
    expect(first.seq).toBe(1);
    expect(second.name).toBe("tool_observed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const jsonl = await readFile(log_path, "utf8");
    expect(jsonl).toContain("adapter_error");
    await bus.close();
  });

  test("redact apiKey and omit rawText in JSONL", async () => {
    const { bus, log_path } = await tmpBus();
    await bus.emit({
      name: "tool_observed",
      payload: {
        source: "visreplay",
        name: "write_file",
        arguments: { apiKey: "sk-secret", path: "out/config.yaml" },
        rawText: "UNIQUE_RAW_TEXT_MARKER",
      } as never,
      producer: PRODUCER,
      correlation_id: bus.run_id,
    });
    const line = (await readFile(log_path, "utf8")).trim();
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("sk-secret");
    expect(line).not.toContain("UNIQUE_RAW_TEXT_MARKER");
    const parsed = JSON.parse(line) as {
      payload: { arguments: Record<string, unknown>; rawText?: unknown };
    };
    expect(parsed.payload.arguments.apiKey).toBe("[REDACTED]");
    expect(parsed.payload.rawText === undefined || parsed.payload.rawText === "[REDACTED]").toBe(
      true,
    );
    await bus.close();
  });
});

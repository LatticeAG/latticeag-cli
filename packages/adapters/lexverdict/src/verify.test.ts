import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LatticeBus,
  newRunId,
  newSessionId,
  type AdapterContext,
} from "@latticeag/bus";
import { createDefaultConfig } from "@latticeag/config";
import type { AnyLatticeEvent, JsonObject } from "@latticeag/events";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import {
  createAdapter,
  MAX_VERIFICATION_FIELD_CHARS,
  sha256Utf8Hex,
} from "./index.js";

const BASE = "http://127.0.0.1:8789";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "latticeag-lexverdict-"));
}

function openBus(dir: string): LatticeBus {
  return new LatticeBus({
    run_id: newRunId(),
    session_id: newSessionId(),
    log_path: join(dir, "events.jsonl"),
    ring_capacity: 10000,
    overflow_block_ms: 10,
    overflow: "drop",
    persist_fail: "throw",
    redact_keys: [],
    include_raw_text: false,
    max_log_bytes: 268435456,
  });
}

function readLog(path: string): AnyLatticeEvent[] {
  try {
    const text = readFileSync(path, "utf8");
    if (text.length === 0) {
      return [];
    }
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AnyLatticeEvent);
  } catch {
    return [];
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timeout waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const buses: LatticeBus[] = [];
const adapters: ReturnType<typeof createAdapter>[] = [];
let mockAgent: MockAgent | undefined;
let previousDispatcher: ReturnType<typeof getGlobalDispatcher> | undefined;

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    await adapter.stop();
  }
  for (const bus of buses.splice(0)) {
    await bus.close();
  }
  if (previousDispatcher) {
    setGlobalDispatcher(previousDispatcher);
    previousDispatcher = undefined;
  }
  if (mockAgent) {
    await mockAgent.close();
    mockAgent = undefined;
  }
});

function useMock(): MockAgent {
  previousDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  return mockAgent;
}

async function startAdapter(dir: string, bus: LatticeBus): Promise<void> {
  const adapter = createAdapter();
  adapters.push(adapter);
  const ctx: AdapterContext = {
    config: createDefaultConfig("lexverdict-test", ["lexverdict"]),
    bus,
    cwd: dir,
    env: { LEXVERDICT_URL: BASE, LATTICEAG_GOAL: "write production config" },
    abort: new AbortController().signal,
    registerIngest() {},
  };
  await adapter.start(ctx);
}

async function emitTool(
  bus: LatticeBus,
  name: string,
  args: JsonObject,
  result: unknown,
): Promise<AnyLatticeEvent> {
  return bus.emit({
    name: "tool_observed",
    producer: {
      product: "axion",
      adapter: "@latticeag/adapter-axion",
      adapter_version: "0.1.0",
    },
    correlation_id: bus.run_id,
    payload: {
      source: "axion",
      name,
      arguments: args,
      result: result as never,
    },
  });
}

describe("lexverdict verify", () => {
  it("maps pass and steer responses onto verdict events", async () => {
    const dir = tempDir();
    const bus = openBus(dir);
    buses.push(bus);
    const agent = useMock();
    const pool = agent.get(BASE);
    pool.intercept({ path: "/v1/verify", method: "POST" }).reply(200, {
      verdict: "steer",
      confidence: 0.82,
      message: "env is staging; goal requires production",
    });
    pool.intercept({ path: "/v1/verify", method: "POST" }).reply(200, {
      verdict: "pass",
      confidence: 0.91,
      message: null,
    });
    await startAdapter(dir, bus);
    const first = await emitTool(
      bus,
      "write_file",
      { path: "config.yaml", env: "staging" },
      { ok: true },
    );
    await waitFor(
      () => readLog(join(dir, "events.jsonl")).some((e) => e.name === "verdict"),
    );
    const second = await emitTool(
      bus,
      "write_file",
      { path: "config.yaml", env: "production" },
      { ok: true },
    );
    await waitFor(
      () =>
        readLog(join(dir, "events.jsonl")).filter((e) => e.name === "verdict")
          .length === 2,
    );
    const verdicts = readLog(join(dir, "events.jsonl")).filter(
      (e) => e.name === "verdict",
    );
    expect(verdicts).toHaveLength(2);
    const steer = verdicts[0];
    const pass = verdicts[1];
    expect(steer?.name).toBe("verdict");
    if (steer?.name === "verdict") {
      expect(steer.payload.verdict).toBe("steer");
      expect(steer.causation_id).toBe(first.id);
      expect(steer.payload.goal).toBe("write production config");
      expect(steer.payload.tool_call_sha256).toBe(
        sha256Utf8Hex(steer.payload.tool_call),
      );
      expect(steer.payload.goal_sha256).toHaveLength(64);
      expect(steer.payload.result_sha256).toHaveLength(64);
    }
    expect(pass?.name).toBe("verdict");
    if (pass?.name === "verdict") {
      expect(pass.payload.verdict).toBe("pass");
      expect(pass.causation_id).toBe(second.id);
      expect(pass.payload.message).toBeNull();
    }
  });

  it("rejects fields over MAX_VERIFICATION_FIELD_CHARS without POSTing", async () => {
    const dir = tempDir();
    const bus = openBus(dir);
    buses.push(bus);
    const agent = useMock();
    agent.get(BASE).intercept({ path: "/v1/verify", method: "POST" }).reply(200, {
      verdict: "pass",
      confidence: 1,
      message: null,
    });
    await startAdapter(dir, bus);
    const huge = "x".repeat(MAX_VERIFICATION_FIELD_CHARS + 1);
    await emitTool(bus, "write_file", { blob: huge }, { ok: true });
    await waitFor(() =>
      readLog(join(dir, "events.jsonl")).some((e) => e.name === "adapter_error"),
    );
    const events = readLog(join(dir, "events.jsonl"));
    expect(events.some((e) => e.name === "verdict")).toBe(false);
    const err = events.find((e) => e.name === "adapter_error");
    expect(err?.name).toBe("adapter_error");
    if (err?.name === "adapter_error") {
      expect(err.payload.message).toMatch(/8000/);
    }
  });

  it("start() throws when LEXVERDICT_URL is unset", async () => {
    const dir = tempDir();
    const bus = openBus(dir);
    buses.push(bus);
    const adapter = createAdapter();
    adapters.push(adapter);
    await expect(
      adapter.start({
        config: createDefaultConfig("lexverdict-test", ["lexverdict"]),
        bus,
        cwd: dir,
        env: {},
        abort: new AbortController().signal,
        registerIngest() {},
      }),
    ).rejects.toThrow(/LEXVERDICT_URL unset/);
  });
});

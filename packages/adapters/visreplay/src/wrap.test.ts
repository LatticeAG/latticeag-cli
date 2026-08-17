import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import type { AnyLatticeEvent } from "@latticeag/events";
import { createAdapter, wrapAgent, WATCH_DEBOUNCE_MS } from "./index.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "latticeag-visreplay-"));
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

async function waitFor(
  pred: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
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

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    await adapter.stop();
  }
  for (const bus of buses.splice(0)) {
    await bus.close();
  }
});

describe("visreplay wrapAgent", () => {
  it("maps wrapped tool_call and tool_result to tool_observed", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".latticeag", "sessions"), { recursive: true });
    const bus = openBus(dir);
    buses.push(bus);
    const adapter = createAdapter();
    adapters.push(adapter);
    const config = createDefaultConfig("visreplay-test", ["visreplay"]);
    const ctx: AdapterContext = {
      config,
      bus,
      cwd: dir,
      env: {},
      abort: new AbortController().signal,
      registerIngest() {},
    };
    await adapter.start(ctx);
    const agent = wrapAgent(
      {
        write_file: async (args: { path: string }) => ({ wrote: args.path }),
      },
      ctx,
    );
    await agent.write_file({ path: "out/config.yaml" });
    await waitFor(
      () =>
        readLog(join(dir, "events.jsonl")).filter((e) => e.name === "tool_observed")
          .length >= 2,
    );
    const tools = readLog(join(dir, "events.jsonl")).filter(
      (e) => e.name === "tool_observed",
    );
    expect(tools.length).toBeGreaterThanOrEqual(2);
    const call = tools.find(
      (e) => e.name === "tool_observed" && e.payload.name === "write_file",
    );
    expect(call?.name).toBe("tool_observed");
    if (call?.name === "tool_observed") {
      expect(call.payload.source).toBe("visreplay");
      expect(call.payload.visreplay_event_id).toBeTruthy();
    }
  });

  it("emits session_recorded when visReplay.save runs at stop", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".latticeag", "sessions"), { recursive: true });
    const bus = openBus(dir);
    buses.push(bus);
    const adapter = createAdapter();
    adapters.push(adapter);
    const ctx: AdapterContext = {
      config: createDefaultConfig("visreplay-test", ["visreplay"]),
      bus,
      cwd: dir,
      env: {},
      abort: new AbortController().signal,
      registerIngest() {},
    };
    await adapter.start(ctx);
    const agent = wrapAgent(
      { ping: () => "pong" },
      ctx,
    );
    agent.ping();
    await adapter.stop();
    const recorded = readLog(join(dir, "events.jsonl")).filter(
      (e) => e.name === "session_recorded",
    );
    expect(recorded).toHaveLength(1);
    if (recorded[0]?.name === "session_recorded") {
      expect(recorded[0].payload.visreplay_schema).toBe("visreplay/session/1.0");
      expect(recorded[0].payload.path).toContain(".latticeag/sessions");
      expect(recorded[0].payload.path.endsWith(".vrs")).toBe(true);
      expect(recorded[0].payload.session_name).toBe(bus.run_id);
    }
  });

  it("emits session_recorded when a .vrs file appears in session_dir", async () => {
    const dir = tempDir();
    const sessionDir = join(dir, ".latticeag", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const bus = openBus(dir);
    buses.push(bus);
    const adapter = createAdapter();
    adapters.push(adapter);
    await adapter.start({
      config: createDefaultConfig("visreplay-test", ["visreplay"]),
      bus,
      cwd: dir,
      env: {},
      abort: new AbortController().signal,
      registerIngest() {},
    });
    const filePath = join(sessionDir, "external.vrs");
    writeFileSync(
      filePath,
      `${JSON.stringify({
        $schema: "visreplay/session/1.0",
        sessionId: "ses_external",
        sessionName: "external",
        agentType: "custom",
        startedAt: "2026-08-17T13:57:00.123Z",
        events: [{ eventId: "evt_1", type: "input", index: 0 }],
      })}\n`,
    );
    await waitFor(
      () =>
        readLog(join(dir, "events.jsonl")).some((e) => e.name === "session_recorded"),
      WATCH_DEBOUNCE_MS + 1500,
    );
    const recorded = readLog(join(dir, "events.jsonl")).filter(
      (e) => e.name === "session_recorded",
    );
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    if (recorded[0]?.name === "session_recorded") {
      expect(recorded[0].payload.visreplay_session_id).toBe("ses_external");
    }
  });
});

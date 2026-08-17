import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import type {
  AnyLatticeEvent,
  BeliefExtractedPayload,
  ToolObservedPayload,
} from "@latticeag/events";
import { createAdapter, LATTICE_NOT_FOUND, projectTranscript } from "./index.js";
import { supportsBeliefs } from "./detect.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "latticeag-viscompile-"));
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

const PRODUCER = {
  product: "axion" as const,
  adapter: "@latticeag/adapter-axion",
  adapter_version: "0.1.0",
};

const BELIEF: BeliefExtractedPayload = {
  belief: {
    id: "belief-assumption-1",
    type: "assumption",
    text: "staging shares prod credentials",
    confidence: 0.5,
    line: 1,
    axion_timestamp_ms: 1755439020123,
  },
  batch: {
    spec: "axion.belief_batch.v1",
    calls_in_session: 1,
    provider: "openai",
    model_name: "gpt-4o",
    inbound_message_count: 2,
    redactions: 0,
  },
};

const TOOL: ToolObservedPayload = {
  source: "axion",
  name: "write_file",
  arguments: {
    path: "out/config.yaml",
    contents: "env: staging\nreplicas: 3\n",
  },
};

function envelope(
  name: "belief_extracted" | "tool_observed",
  payload: BeliefExtractedPayload | ToolObservedPayload,
  seq: number,
  runId: string,
): AnyLatticeEvent {
  return {
    $schema: "latticeag.events/1.0",
    schema_version: 1,
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    seq,
    ts: "2026-08-17T13:57:00.123Z",
    run_id: runId,
    session_id: "ses_demo",
    producer: PRODUCER,
    correlation_id: runId,
    redaction: { applied: false, keys: [], pattern_hits: 0 },
    name,
    payload,
  } as AnyLatticeEvent;
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

describe("projectTranscript", () => {
  const runId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
  const events = [
    envelope("belief_extracted", BELIEF, 1, runId),
    envelope("tool_observed", TOOL, 2, runId),
  ];
  const input = {
    prompt: "Write production config.yaml with env: production and replicas: 3",
  };

  it("v1 omits beliefs", () => {
    const doc = projectTranscript(events, "runs-on-latticeag", input, 1);
    expect(doc.kind).toBe("latticeag.viscompile.transcript");
    expect(doc.schema_version).toBe(1);
    expect(doc.cases).toHaveLength(1);
    const types = doc.cases[0]?.events.map((e) => e.type);
    expect(types).toEqual(["tool_call", "final"]);
    expect(
      doc.cases[0]?.events.some((e) => e.type === "belief"),
    ).toBe(false);
    const tool = doc.cases[0]?.events.find((e) => e.type === "tool_call");
    expect(tool).toMatchObject({
      type: "tool_call",
      name: "write_file",
    });
  });

  it("v2 includes beliefs", () => {
    const doc = projectTranscript(events, "runs-on-latticeag", input, 2);
    expect(doc.schema_version).toBe(2);
    const types = doc.cases[0]?.events.map((e) => e.type);
    expect(types).toEqual(["belief", "tool_call", "final"]);
    const belief = doc.cases[0]?.events.find((e) => e.type === "belief");
    expect(belief).toMatchObject({
      type: "belief",
      belief_type: "assumption",
      text: "staging shares prod credentials",
      confidence: 0.5,
      id: "belief-assumption-1",
    });
  });
});

describe("viscompile adapter without lattice", () => {
  it("emits adapter_error lattice binary not found and does not throw", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "fixtures"), { recursive: true });
    writeFileSync(
      join(dir, "fixtures", "baseline.snapshot.json"),
      `${JSON.stringify({
        kind: "latticeag.viscompile.transcript",
        schema_version: 1,
        cases: [
          {
            id: "runs-on-latticeag",
            input: { prompt: "x" },
            events: [{ type: "final", output: {} }],
          },
        ],
      })}\n`,
    );
    const bus = openBus(dir);
    buses.push(bus);
    const adapter = createAdapter();
    adapters.push(adapter);
    const config = createDefaultConfig("runs-on-latticeag", ["viscompile"]);
    await adapter.start({
      config,
      bus,
      cwd: dir,
      env: { PATH: "/no/such/lattice/bin" },
      abort: new AbortController().signal,
      registerIngest() {
        return;
      },
    } satisfies AdapterContext);
    await adapter.stop();
    const log = readLog(join(dir, "events.jsonl"));
    const errors = log.filter((e) => e.name === "adapter_error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const messages = errors
      .filter((e) => e.name === "adapter_error")
      .map((e) => e.payload.message);
    expect(messages).toContain(LATTICE_NOT_FOUND);
    expect(log.some((e) => e.name === "diff_computed")).toBe(false);
  });

  it("emits adapter_error and skips when baseline is missing", async () => {
    const dir = tempDir();
    const bus = openBus(dir);
    buses.push(bus);
    const adapter = createAdapter();
    adapters.push(adapter);
    const config = createDefaultConfig("runs-on-latticeag", ["viscompile"]);
    await adapter.start({
      config,
      bus,
      cwd: dir,
      env: { PATH: "/no/such/lattice/bin" },
      abort: new AbortController().signal,
      registerIngest() {
        return;
      },
    } satisfies AdapterContext);
    await adapter.stop();
    const log = readLog(join(dir, "events.jsonl"));
    const errors = log.filter((e) => e.name === "adapter_error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    if (errors[0]?.name === "adapter_error") {
      expect(errors[0].payload.message).toMatch(/baseline not found/);
    }
  });
});

function resolveLatticeBin(): string | undefined {
  const dirs = (process.env.PATH ?? "").split(":");
  dirs.push(join(process.env.HOME ?? "", ".cargo", "bin"));
  for (const dir of dirs) {
    const candidate = join(dir, "lattice");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

describe.skipIf(!resolveLatticeBin())("viscompile spawn", () => {
  it("supportsBeliefs returns a boolean for the installed lattice", async () => {
    const bin = resolveLatticeBin();
    expect(bin).toBeTruthy();
    if (!bin) {
      return;
    }
    const result = await supportsBeliefs(bin);
    expect(typeof result).toBe("boolean");
  });
});

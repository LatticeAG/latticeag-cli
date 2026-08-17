import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  LatticeBus,
  newRunId,
  newSessionId,
  type AdapterContext,
} from "@latticeag/bus";
import { createDefaultConfig } from "@latticeag/config";
import type { AnyLatticeEvent } from "@latticeag/events";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import {
  createAdapter,
  signAxionBody,
  type BeliefBatchWebhookPayload,
  type IngestRequest,
} from "./index.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "latticeag-axion-"));
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
    redact_keys: ["rawText", "argumentsRedacted"],
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

function sampleBatch(): BeliefBatchWebhookPayload {
  return {
    spec: "axion.belief_batch.v1",
    sessionId: "ses_test",
    timestamp: 1755439020123,
    provider: "openai",
    modelName: "gpt-4.1-mini",
    callsInSession: 2,
    inboundMessageCount: 3,
    redactions: 0,
    beliefs: [
      {
        id: "belief-1",
        type: "assumption",
        belief: "staging shares prod credentials",
        confidence: 0.5,
        timestamp: 1755439020123,
        line: 1,
        actionTaken: "write staging config",
      },
      {
        id: "belief-2",
        type: "intention",
        belief: "switch env to production",
        confidence: 0.8,
        timestamp: 1755439020124,
        line: 2,
      },
    ],
    actions: [
      {
        id: "call_write_1",
        name: "write_file",
        provider: "openai",
        source: "tool_calls",
        argumentFingerprint: "aa".repeat(32),
        argumentFingerprintSource: "canonical",
        argumentBytes: 42,
        sourceClass: "tool_observed",
        arguments: { path: "config.yaml" },
      },
    ],
  };
}

interface CapturedRes {
  status: number;
  body: string;
}

function mockRes(): { res: ServerResponse; rec: CapturedRes } {
  const rec: CapturedRes = { status: 0, body: "" };
  const res = {
    statusCode: 200,
    writeHead(code: number) {
      rec.status = code;
      return this;
    },
    end(chunk?: string) {
      rec.body = chunk ?? "";
      if (rec.status === 0) {
        rec.status = this.statusCode;
      }
    },
  };
  return { res: res as unknown as ServerResponse, rec };
}

function mockReq(
  headers: Record<string, string>,
  raw: Buffer,
): IngestRequest {
  return {
    headers,
    rawBody: raw,
  } as IngestRequest;
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

async function startWebhook(env: NodeJS.ProcessEnv): Promise<{
  dir: string;
  bus: LatticeBus;
  logPath: string;
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ) => Promise<void> | void;
}> {
  const dir = tempDir();
  const bus = openBus(dir);
  buses.push(bus);
  const adapter = createAdapter();
  adapters.push(adapter);
  let handle:
    | ((
        req: IncomingMessage,
        res: ServerResponse,
        body: unknown,
      ) => Promise<void> | void)
    | undefined;
  const ac = new AbortController();
  const ctx: AdapterContext = {
    config: createDefaultConfig("axion-test", ["axion"]),
    bus,
    cwd: dir,
    env,
    abort: ac.signal,
    registerIngest(_path, handler) {
      handle = handler;
    },
  };
  await adapter.start(ctx);
  if (!handle) {
    throw new Error("registerIngest was not called");
  }
  return { dir, bus, logPath: join(dir, "events.jsonl"), handle };
}

describe("axion webhook", () => {
  it("HMAC 401 emits zero JSONL lines", async () => {
    const secret = "test-webhook-secret";
    const { logPath, handle } = await startWebhook({
      AXION_WEBHOOK_SECRET: secret,
    });
    const payload = sampleBatch();
    const raw = Buffer.from(JSON.stringify(payload));
    const { res, rec } = mockRes();
    await handle(
      mockReq({ "x-axion-signature": "sha256=deadbeef" }, raw),
      res,
      payload,
    );
    expect(rec.status).toBe(401);
    expect(readLog(logPath)).toEqual([]);
  });

  it("maps N beliefs onto N events sharing causation_id and batch", async () => {
    const secret = "test-webhook-secret";
    const { logPath, handle, bus } = await startWebhook({
      AXION_WEBHOOK_SECRET: secret,
    });
    const payload = sampleBatch();
    const raw = Buffer.from(JSON.stringify(payload));
    const { res, rec } = mockRes();
    await handle(
      mockReq({ "x-axion-signature": signAxionBody(secret, raw) }, raw),
      res,
      payload,
    );
    expect(rec.status).toBe(200);
    const events = readLog(logPath);
    const beliefs = events.filter((e) => e.name === "belief_extracted");
    const tools = events.filter((e) => e.name === "tool_observed");
    expect(beliefs).toHaveLength(2);
    expect(tools).toHaveLength(1);
    const firstId = beliefs[0]?.id;
    expect(firstId).toBeTruthy();
    for (const event of beliefs) {
      expect(event.causation_id).toBe(firstId);
      if (event.name === "belief_extracted") {
        expect(event.payload.batch).toEqual(beliefs[0]?.payload.batch);
        expect(event.payload.batch.spec).toBe("axion.belief_batch.v1");
        expect(event.payload.batch.calls_in_session).toBe(2);
      }
    }
    const first = beliefs[0];
    const second = beliefs[1];
    expect(first?.name).toBe("belief_extracted");
    expect(second?.name).toBe("belief_extracted");
    if (first?.name === "belief_extracted") {
      expect(first.payload.belief.text).toBe("staging shares prod credentials");
      expect(first.payload.belief.action_taken).toBe("write staging config");
      expect(first.payload.belief.axion_timestamp_ms).toBe(1755439020123);
    }
    if (second?.name === "belief_extracted") {
      expect(second.payload.belief.text).toBe("switch env to production");
    }
    expect(tools[0]?.name).toBe("tool_observed");
    if (tools[0]?.name === "tool_observed") {
      expect(tools[0].payload.source).toBe("axion");
      expect(tools[0].payload.name).toBe("write_file");
      expect(tools[0].payload.axion_action_id).toBe("call_write_1");
    }
    expect(bus.seq()).toBe(events.length);
  });

  it("unsigned webhooks are refused unless AXION_WEBHOOK_ALLOW_UNSIGNED=true", async () => {
    const { logPath, handle } = await startWebhook({
      AXION_WEBHOOK_SECRET: "test-webhook-secret",
    });
    const payload = sampleBatch();
    const raw = Buffer.from(JSON.stringify(payload));
    const { res, rec } = mockRes();
    await handle(mockReq({}, raw), res, payload);
    expect(rec.status).toBe(401);
    expect(readLog(logPath)).toEqual([]);
  });

  it("polls GET /api/beliefs/:id and maps unseen belief ids", async () => {
    const dir = tempDir();
    const bus = openBus(dir);
    buses.push(bus);
    const previous = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    try {
      const pool = agent.get("http://127.0.0.1:8787");
      pool
        .intercept({ path: `/api/beliefs/${bus.session_id}`, method: "GET" })
        .reply(200, sampleBatch());
      const adapter = createAdapter();
      adapters.push(adapter);
      const config = createDefaultConfig("axion-poll", ["axion"]);
      config.adapters.axion.mode = "poll";
      config.adapters.axion.poll_interval_ms = 10_000;
      const ac = new AbortController();
      await adapter.start({
        config,
        bus,
        cwd: dir,
        env: { AXION_READ_TOKEN: "test-read-token" },
        abort: ac.signal,
        registerIngest() {
          throw new Error("poll mode must not register ingest");
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const events = readLog(join(dir, "events.jsonl"));
      expect(events.filter((e) => e.name === "belief_extracted")).toHaveLength(2);
    } finally {
      setGlobalDispatcher(previous);
      await agent.close();
    }
  });
});

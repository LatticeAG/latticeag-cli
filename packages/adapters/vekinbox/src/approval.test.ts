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
  signVekinboxBody,
  shouldAutoApprove,
  type IngestRequest,
} from "./index.js";

const BASE = "http://127.0.0.1:3001/v1";
const ORIGIN = "http://127.0.0.1:3001";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "latticeag-vekinbox-"));
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

interface CapturedRes {
  status: number;
}

function mockRes(): { res: ServerResponse; rec: CapturedRes } {
  const rec: CapturedRes = { status: 0 };
  const res = {
    statusCode: 200,
    writeHead(code: number) {
      rec.status = code;
      return this;
    },
    end() {
      if (rec.status === 0) {
        rec.status = this.statusCode;
      }
    },
  };
  return { res: res as unknown as ServerResponse, rec };
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

async function startWith(
  env: NodeJS.ProcessEnv,
): Promise<{
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
  await adapter.start({
    config: createDefaultConfig("vekinbox-test", ["vekinbox"]),
    bus,
    cwd: dir,
    env: {
      VEKINBOX_URL: BASE,
      VEKINBOX_API_KEY: env.VEKINBOX_API_KEY ?? "vk_test_ci",
      VEKINBOX_WORKSPACE_ID: "ws_test",
      VEKINBOX_AGENT_ID: "agt_test",
      VEKINBOX_WEBHOOK_SECRET: "test-webhook-secret",
      ...env,
    },
    abort: new AbortController().signal,
    registerIngest(_path, h) {
      handle = h;
    },
  } satisfies AdapterContext);
  if (!handle) {
    throw new Error("registerIngest was not called");
  }
  return { dir, bus, logPath: join(dir, "events.jsonl"), handle };
}

async function emitSteer(bus: LatticeBus): Promise<AnyLatticeEvent> {
  return bus.emit({
    name: "verdict",
    producer: {
      product: "lexverdict",
      adapter: "@latticeag/adapter-lexverdict",
      adapter_version: "0.1.0",
    },
    correlation_id: bus.run_id,
    payload: {
      verdict: "steer",
      confidence: 0.8,
      message: "fix env",
      tool_call: "write_file {}",
      goal: "complete the user task",
      result: "{}",
      tool_call_sha256: "a".repeat(64),
      goal_sha256: "b".repeat(64),
      result_sha256: "c".repeat(64),
      latency_ms: 12,
    },
  });
}

describe("vekinbox auto-approve guard", () => {
  it("honors VEKINBOX_AUTO_APPROVE=1 only for vk_test_ keys", () => {
    expect(
      shouldAutoApprove({
        VEKINBOX_AUTO_APPROVE: "1",
        VEKINBOX_API_KEY: "vk_test_ci",
      }),
    ).toBe(true);
    expect(
      shouldAutoApprove({
        VEKINBOX_AUTO_APPROVE: "1",
        VEKINBOX_API_KEY: "vk_live_prod",
      }),
    ).toBe(false);
    expect(
      shouldAutoApprove({
        VEKINBOX_AUTO_APPROVE: "0",
        VEKINBOX_API_KEY: "vk_test_ci",
      }),
    ).toBe(false);
  });
});

describe("vekinbox approval", () => {
  it("approved webhook path emits approval_granted", async () => {
    const agent = useMock();
    agent.get(ORIGIN).intercept({ path: "/v1/requests", method: "POST" }).reply(200, {
      id: "req_1",
      key: "pending",
      title: "Approve after verdict",
      workspace_id: "ws_test",
      agent_id: "agt_test",
      status: "pending",
      priority: "normal",
      metadata: {},
    });
    const { bus, logPath, handle } = await startWith({
      VEKINBOX_API_KEY: "vk_test_ci",
    });
    const steer = await emitSteer(bus);
    await waitFor(() => true);
    await new Promise((r) => setTimeout(r, 50));
    const key = `${bus.run_id}.${steer.id}`;
    const payload = {
      request_id: "req_1",
      workspace_id: "ws_test",
      agent_id: "agt_test",
      key,
      status: "approved",
      action: "approve",
      resolved_by: "user_ci",
      resolved_at: "2026-08-17T13:57:00.123Z",
      title: "Approve after verdict",
      priority: "normal",
    };
    const raw = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const { res, rec } = mockRes();
    await handle(
      {
        headers: {
          "x-vekinbox-signature": signVekinboxBody(
            "test-webhook-secret",
            timestamp,
            raw,
          ),
          "x-vekinbox-timestamp": timestamp,
        },
        rawBody: Buffer.from(raw),
      } as IngestRequest,
      res,
      payload,
    );
    expect(rec.status).toBe(200);
    await waitFor(() =>
      readLog(logPath).some((e) => e.name === "approval_granted"),
    );
    const granted = readLog(logPath).filter((e) => e.name === "approval_granted");
    expect(granted).toHaveLength(1);
    if (granted[0]?.name === "approval_granted") {
      expect(granted[0].payload.status).toBe("approved");
      expect(granted[0].payload.key).toBe(key);
      expect(granted[0].payload.resolved_by).toBe("user_ci");
    }
  });

  it("vk_live_ ignores VEKINBOX_AUTO_APPROVE=1 and waits", async () => {
    const agent = useMock();
    agent.get(ORIGIN).intercept({ path: "/v1/requests", method: "POST" }).reply(200, {
      id: "req_live",
      key: "live-key",
      title: "Approve after verdict",
      workspace_id: "ws_test",
      agent_id: "agt_test",
      status: "pending",
      priority: "normal",
      metadata: {},
    });
    const { bus, logPath } = await startWith({
      VEKINBOX_API_KEY: "vk_live_prod",
      VEKINBOX_AUTO_APPROVE: "1",
    });
    await emitSteer(bus);
    await new Promise((r) => setTimeout(r, 80));
    expect(readLog(logPath).some((e) => e.name === "approval_granted")).toBe(
      false,
    );
  });

  it("idempotency key replay does not double-emit", async () => {
    const agent = useMock();
    agent.get(ORIGIN).intercept({ path: "/v1/requests", method: "POST" }).reply(200, {
      id: "req_dup",
      workspace_id: "ws_test",
      agent_id: "agt_test",
      status: "pending",
      priority: "normal",
      metadata: {},
    });
    const { bus, logPath, handle } = await startWith({
      VEKINBOX_API_KEY: "vk_test_ci",
    });
    const steer = await emitSteer(bus);
    await new Promise((r) => setTimeout(r, 50));
    const key = `${bus.run_id}.${steer.id}`;
    const payload = {
      request_id: "req_dup",
      workspace_id: "ws_test",
      agent_id: "agt_test",
      key,
      status: "approved",
      action: "approve",
      resolved_at: "2026-08-17T13:57:00.123Z",
      title: "Approve after verdict",
      priority: "normal",
    };
    const deliver = async () => {
      const raw = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const { res } = mockRes();
      await handle(
        {
          headers: {
            "x-vekinbox-signature": signVekinboxBody(
              "test-webhook-secret",
              timestamp,
              raw,
            ),
            "x-vekinbox-timestamp": timestamp,
          },
          rawBody: Buffer.from(raw),
        } as IngestRequest,
        res,
        payload,
      );
    };
    await deliver();
    await deliver();
    await waitFor(() =>
      readLog(logPath).some((e) => e.name === "approval_granted"),
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(
      readLog(logPath).filter((e) => e.name === "approval_granted"),
    ).toHaveLength(1);
  });
});

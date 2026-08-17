import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Adapter,
  AdapterContext,
  AdapterHealth,
  LatticeBus,
} from "@latticeag/bus";
import type {
  AnyLatticeEvent,
  ApprovalGrantedPayload,
  CompensationExecutedPayload,
  PolicyDecisionEvent,
  Producer,
  ReceiptIssuedPayload,
  VerdictEvent,
} from "@latticeag/events";
import { AUTO_APPROVE_RESOLVED_BY, shouldAutoApprove } from "./auto-approve.js";

export { shouldAutoApprove, AUTO_APPROVE_RESOLVED_BY } from "./auto-approve.js";

export const ADAPTER_VERSION = "0.1.0";
export const ADAPTER_ID = "vekinbox";
export const WEBHOOK_MAX_TIMESTAMP_SKEW_MS = 300000;
export const DESCRIPTION_MAX_CHARS = 20480;

const PRODUCER: Producer = {
  product: "vekinbox",
  adapter: "@latticeag/adapter-vekinbox",
  adapter_version: ADAPTER_VERSION,
};

export type IngestRequest = IncomingMessage & { rawBody?: Buffer };

interface CreatedRequest {
  id: string;
  key: string;
  title: string;
  workspaceId: string;
  agentId: string;
  status: string;
  priority: ApprovalGrantedPayload["priority"];
  resolvedBy?: string;
  resolvedAt?: string;
  note?: string;
  action?: string;
  metadata?: Record<string, unknown>;
}

export interface FixtureApproval {
  key: string;
  request_id: string;
  status: string;
  title: string;
  action: string;
  workspace_id: string;
  agent_id: string;
  resolved_at: string;
  resolved_by?: string;
  priority: ApprovalGrantedPayload["priority"];
  note?: string;
  receipt?: Omit<ReceiptIssuedPayload, "source">;
  compensation?: Omit<CompensationExecutedPayload, "source">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function signVekinboxBody(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return `sha256=${hmacHex(secret, `${timestamp}.${body}`)}`;
}

function getHeader(
  headers: IncomingMessage["headers"],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  const direct = headers[lower] ?? headers[name];
  if (Array.isArray(direct)) {
    return direct[0];
  }
  return direct;
}

export function verifyVekinboxSignature(
  headers: IncomingMessage["headers"],
  rawBody: string | Buffer,
  secret: string,
  nowMs = Date.now(),
): boolean {
  const signatureHeader = getHeader(headers, "x-vekinbox-signature");
  const timestamp = getHeader(headers, "x-vekinbox-timestamp");
  if (!signatureHeader || !timestamp) {
    return false;
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return false;
  }
  if (Math.abs(nowMs - ts * 1000) > WEBHOOK_MAX_TIMESTAMP_SKEW_MS) {
    return false;
  }
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = hmacHex(secret, `${timestamp}.${body}`);
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function healthUrl(vekinboxUrl: string): string {
  try {
    return `${new URL(vekinboxUrl).origin}/health`;
  } catch {
    return vekinboxUrl;
  }
}

function ingestBase(ctx: AdapterContext): string {
  return (
    ctx.env.LATTICEAG_INGEST_URL ??
    `http://${ctx.config.ingest.bind}:${ctx.config.ingest.port}${ctx.config.ingest.path}`
  );
}

function truncateJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length <= DESCRIPTION_MAX_CHARS) {
    return text;
  }
  return text.slice(0, DESCRIPTION_MAX_CHARS);
}

function parseDurationMs(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration.trim());
  if (!match) {
    return 3_600_000;
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * (multipliers[unit ?? "h"] ?? 3_600_000);
}

function fromApiRequest(raw: Record<string, unknown>): CreatedRequest {
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
  const priorityRaw = raw.priority;
  const priority: ApprovalGrantedPayload["priority"] =
    priorityRaw === "low" ||
    priorityRaw === "high" ||
    priorityRaw === "critical" ||
    priorityRaw === "normal"
      ? priorityRaw
      : "normal";
  return {
    id: String(raw.id ?? ""),
    key: String(raw.key ?? ""),
    title: String(raw.title ?? ""),
    workspaceId: String(raw.workspace_id ?? raw.workspaceId ?? ""),
    agentId: String(raw.agent_id ?? raw.agentId ?? ""),
    status: String(raw.status ?? "pending"),
    priority,
    ...(typeof raw.resolved_by === "string" || typeof raw.resolvedBy === "string"
      ? { resolvedBy: String(raw.resolved_by ?? raw.resolvedBy) }
      : {}),
    ...(typeof raw.resolved_at === "string" || typeof raw.resolvedAt === "string"
      ? { resolvedAt: String(raw.resolved_at ?? raw.resolvedAt) }
      : {}),
    ...(typeof raw.note === "string" ? { note: raw.note } : {}),
    ...(typeof raw.action === "string" ? { action: raw.action } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

async function apiRequest(
  ctx: AdapterContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const base = (ctx.env.VEKINBOX_URL ?? "").replace(/\/$/, "");
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.env.VEKINBOX_API_KEY ?? ""}`,
    accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    throw new Error(`VekInbox API error: ${res.status} ${text}`);
  }
  return (isRecord(parsed) ? parsed : {}) as Record<string, unknown>;
}

function compensationFromMetadata(
  requestId: string,
  metadata: Record<string, unknown> | undefined,
): CompensationExecutedPayload | undefined {
  if (!metadata || !isRecord(metadata.compensation)) {
    return undefined;
  }
  const c = metadata.compensation;
  if (typeof c.execution_id !== "string" || typeof c.action !== "string") {
    return undefined;
  }
  const state_to =
    c.state_to === "failed_verified" ||
    c.state_to === "invalidated" ||
    c.state_to === "executed"
      ? c.state_to
      : "executed";
  return {
    request_id: requestId,
    execution_id: c.execution_id,
    state_from: "compensation_required",
    state_to,
    action: c.action,
    ...(typeof c.note === "string" ? { note: c.note } : {}),
    source: "metadata",
  };
}

function receiptFromMetadata(
  requestId: string,
  metadata: Record<string, unknown> | undefined,
): ReceiptIssuedPayload | undefined {
  if (!metadata || !isRecord(metadata.receipt)) {
    return undefined;
  }
  const r = metadata.receipt;
  if (
    typeof r.execution_id !== "string" ||
    typeof r.action !== "string" ||
    typeof r.issued_at !== "string" ||
    typeof r.payload_sha256 !== "string"
  ) {
    return undefined;
  }
  const tier =
    r.tier === "gateway_verified" || r.tier === "downstream_attested"
      ? r.tier
      : "agent_asserted";
  return {
    request_id: requestId,
    execution_id: r.execution_id,
    tier,
    action: r.action,
    issued_at: r.issued_at,
    payload_sha256: r.payload_sha256,
    source: "metadata",
  };
}

async function emitApproved(
  bus: LatticeBus,
  payload: ApprovalGrantedPayload,
  causationId: string,
): Promise<void> {
  await bus.emit({
    name: "approval_granted",
    producer: PRODUCER,
    correlation_id: bus.run_id,
    causation_id: causationId,
    payload,
  });
}

async function emitSideEffects(
  bus: LatticeBus,
  requestId: string,
  metadata: Record<string, unknown> | undefined,
  causationId: string,
): Promise<void> {
  const receipt = receiptFromMetadata(requestId, metadata);
  if (receipt) {
    await bus.emit({
      name: "receipt_issued",
      producer: PRODUCER,
      correlation_id: bus.run_id,
      causation_id: causationId,
      payload: receipt,
    });
  }
  const compensation = compensationFromMetadata(requestId, metadata);
  if (compensation) {
    await bus.emit({
      name: "compensation_executed",
      producer: PRODUCER,
      correlation_id: bus.run_id,
      causation_id: causationId,
      payload: compensation,
    });
  }
}

export function createAdapter(): Adapter {
  let ctx: AdapterContext | undefined;
  const unsubs: Array<() => void> = [];
  const createdKeys = new Set<string>();
  const resolvedKeys = new Set<string>();
  const pollers = new Set<ReturnType<typeof setTimeout>>();
  let lastHealth: AdapterHealth = {
    id: ADAPTER_ID,
    ok: false,
    detail: "not started",
  };

  async function resolveApproved(
    request: CreatedRequest,
    causationId: string,
    action = "approve",
  ): Promise<void> {
    if (!ctx) {
      return;
    }
    if (resolvedKeys.has(request.key)) {
      return;
    }
    if (request.status !== "approved") {
      return;
    }
    resolvedKeys.add(request.key);
    const payload: ApprovalGrantedPayload = {
      request_id: request.id,
      key: request.key,
      title: request.title,
      workspace_id: request.workspaceId,
      agent_id: request.agentId,
      status: "approved",
      action: request.action ?? action,
      resolved_at: request.resolvedAt ?? new Date().toISOString(),
      priority: request.priority,
      ...(request.resolvedBy !== undefined
        ? { resolved_by: request.resolvedBy }
        : {}),
      ...(request.note !== undefined ? { note: request.note } : {}),
    };
    await emitApproved(ctx.bus, payload, causationId);
    await emitSideEffects(ctx.bus, request.id, request.metadata, causationId);
  }

  async function waitForResolution(
    requestId: string,
    key: string,
    causationId: string,
  ): Promise<void> {
    if (!ctx) {
      return;
    }
    const timeoutMs = parseDurationMs(ctx.config.adapters.vekinbox.timeout);
    const deadline = Date.now() + timeoutMs;
    const poll = async () => {
      if (!ctx || resolvedKeys.has(key) || Date.now() > deadline) {
        return;
      }
      try {
        const raw = await apiRequest(
          ctx,
          "GET",
          `/requests/${encodeURIComponent(requestId)}`,
        );
        const request = fromApiRequest(raw);
        if (request.status === "approved") {
          await resolveApproved(request, causationId);
          return;
        }
        if (request.status !== "pending" && request.status !== "escalated") {
          return;
        }
      } catch {
        // poller is fallback; webhook is the primary path
      }
      const t = setTimeout(() => {
        void poll();
      }, 2000);
      t.unref?.();
      pollers.add(t);
    };
    await poll();
  }

  const storedFixtures: FixtureApproval[] = [];
  const usedFixtureIndexes = new Set<number>();

  function takeFixture(eventKey: string): FixtureApproval | undefined {
    const matchIdx = storedFixtures.findIndex(
      (row, i) =>
        !usedFixtureIndexes.has(i) &&
        row.status === "approved" &&
        row.key === eventKey,
    );
    if (matchIdx >= 0) {
      usedFixtureIndexes.add(matchIdx);
      return storedFixtures[matchIdx];
    }
    const firstIdx = storedFixtures.findIndex(
      (row, i) => !usedFixtureIndexes.has(i) && row.status === "approved",
    );
    if (firstIdx >= 0) {
      usedFixtureIndexes.add(firstIdx);
      return storedFixtures[firstIdx];
    }
    return undefined;
  }

  async function emitFixtureRow(
    row: FixtureApproval,
    causationId: string,
    eventKey: string,
  ): Promise<void> {
    if (!ctx) {
      return;
    }
    if (resolvedKeys.has(eventKey) || resolvedKeys.has(row.key)) {
      return;
    }
    resolvedKeys.add(eventKey);
    resolvedKeys.add(row.key);
    const payload: ApprovalGrantedPayload = {
      request_id: row.request_id,
      key: row.key,
      title: row.title,
      workspace_id: row.workspace_id,
      agent_id: row.agent_id,
      status: "approved",
      action: row.action,
      resolved_at: row.resolved_at,
      priority: row.priority,
      ...(row.resolved_by !== undefined ? { resolved_by: row.resolved_by } : {}),
      ...(row.note !== undefined ? { note: row.note } : {}),
    };
    await emitApproved(ctx.bus, payload, causationId);
    if (row.receipt) {
      await ctx.bus.emit({
        name: "receipt_issued",
        producer: PRODUCER,
        correlation_id: ctx.bus.run_id,
        causation_id: causationId,
        payload: { ...row.receipt, source: "fixture" },
      });
    }
    if (row.compensation) {
      await ctx.bus.emit({
        name: "compensation_executed",
        producer: PRODUCER,
        correlation_id: ctx.bus.run_id,
        causation_id: causationId,
        payload: { ...row.compensation, source: "fixture" },
      });
    }
  }

  async function emitSyntheticAutoApprove(
    event: AnyLatticeEvent,
    key: string,
    sourceName: string,
  ): Promise<void> {
    if (!ctx || resolvedKeys.has(key)) {
      return;
    }
    resolvedKeys.add(key);
    const payload: ApprovalGrantedPayload = {
      request_id: `req_auto_${event.id}`,
      key,
      title: `Approve after ${sourceName}`,
      workspace_id: ctx.env.VEKINBOX_WORKSPACE_ID ?? "",
      agent_id: ctx.env.VEKINBOX_AGENT_ID ?? "",
      status: "approved",
      action: "approve",
      resolved_at: new Date().toISOString(),
      resolved_by: AUTO_APPROVE_RESOLVED_BY,
      priority: "normal",
    };
    await emitApproved(ctx.bus, payload, event.id);
  }

  async function createFromEvent(
    event: AnyLatticeEvent,
    sourceName: string,
  ): Promise<void> {
    if (!ctx) {
      return;
    }
    const key = `${ctx.bus.run_id}.${event.id}`;
    if (createdKeys.has(key)) {
      return;
    }
    createdKeys.add(key);
    if (storedFixtures.length > 0) {
      const row = takeFixture(key);
      if (row) {
        await emitFixtureRow(row, event.id, key);
      }
      return;
    }
    const workspaceId = ctx.env.VEKINBOX_WORKSPACE_ID ?? "";
    const agentId = ctx.env.VEKINBOX_AGENT_ID ?? "";
    // SDK: inbox.requests.create({ workspaceId, agentId, key, title, description, resumeWebhook })
    const body = {
      workspace_id: workspaceId,
      agent_id: agentId,
      key,
      title: `Approve after ${sourceName}`,
      description: truncateJson(event.payload),
      resume_webhook_url: `${ingestBase(ctx)}/vekinbox`,
    };
    try {
      const raw = await apiRequest(ctx, "POST", "/requests", body);
      const request = fromApiRequest(raw);
      if (shouldAutoApprove(ctx.env)) {
        request.status = "approved";
        request.resolvedBy = AUTO_APPROVE_RESOLVED_BY;
        request.resolvedAt = new Date().toISOString();
        request.action = "approve";
        await resolveApproved(request, event.id, "approve");
        return;
      }
      void waitForResolution(request.id, key, event.id);
    } catch {
      if (shouldAutoApprove(ctx.env)) {
        await emitSyntheticAutoApprove(event, key, sourceName);
      }
    }
  }

  async function handleIngest(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    if (!ctx) {
      json(res, 503, { ok: false, error: "not started" });
      return;
    }
    const secret = ctx.env.VEKINBOX_WEBHOOK_SECRET ?? "";
    const raw = (req as IngestRequest).rawBody ?? Buffer.from("");
    if (!verifyVekinboxSignature(req.headers, raw, secret)) {
      json(res, 401, { ok: false, error: "invalid signature" });
      return;
    }
    if (!isRecord(body) || typeof body.key !== "string") {
      json(res, 400, { ok: false, error: "invalid payload" });
      return;
    }
    const request = fromApiRequest({
      id: body.request_id,
      key: body.key,
      title: body.title ?? `Approve after webhook`,
      workspace_id: body.workspace_id,
      agent_id: body.agent_id,
      status: body.status,
      priority: body.priority ?? "normal",
      resolved_by: body.resolved_by,
      resolved_at: body.resolved_at,
      note: body.note,
      action: body.action,
      metadata: body.metadata,
    });
    const causationId = request.key.includes(".")
      ? request.key.slice(request.key.indexOf(".") + 1)
      : request.key;
    await resolveApproved(request, causationId, String(body.action ?? "approve"));
    json(res, 200, { ok: true });
  }

  function loadFixtures(filePath: string): void {
    const rows = JSON.parse(readFileSync(filePath, "utf8")) as FixtureApproval[];
    storedFixtures.splice(0, storedFixtures.length, ...rows);
    usedFixtureIndexes.clear();
  }

  return {
    id: ADAPTER_ID,
    product: "vekinbox",
    async start(startCtx: AdapterContext): Promise<void> {
      ctx = startCtx;
      createdKeys.clear();
      resolvedKeys.clear();
      storedFixtures.length = 0;
      usedFixtureIndexes.clear();
      const fixture =
        startCtx.env.LATTICEAG_FIXTURE_APPROVALS ??
        process.env.LATTICEAG_FIXTURE_APPROVALS;
      if (typeof fixture === "string" && fixture.trim().length > 0) {
        loadFixtures(fixture);
      }
      startCtx.registerIngest("/vekinbox", handleIngest);
      unsubs.push(
        startCtx.bus.subscribe("verdict", (event) => {
          if (event.name !== "verdict") {
            return;
          }
          const payload = (event as VerdictEvent).payload;
          if (payload.verdict === "steer") {
            void createFromEvent(event, event.name);
          }
        }),
      );
      unsubs.push(
        startCtx.bus.subscribe("policy_decision", (event) => {
          if (event.name !== "policy_decision") {
            return;
          }
          const payload = (event as PolicyDecisionEvent).payload;
          if (payload.decision === "CHALLENGE") {
            void createFromEvent(event, event.name);
          }
        }),
      );
      lastHealth = {
        id: ADAPTER_ID,
        ok: true,
        detail: startCtx.env.VEKINBOX_URL ?? "started",
      };
    },
    async health(): Promise<AdapterHealth> {
      if (!ctx) {
        return lastHealth;
      }
      const url = healthUrl(ctx.env.VEKINBOX_URL ?? "");
      try {
        const res = await fetch(url);
        const body = (await res.json()) as { status?: unknown };
        const ok = res.ok && body.status === "ok";
        lastHealth = { id: ADAPTER_ID, ok, detail: url };
      } catch (err) {
        lastHealth = {
          id: ADAPTER_ID,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      return lastHealth;
    },
    async stop(): Promise<void> {
      for (const t of pollers) {
        clearTimeout(t);
      }
      pollers.clear();
      for (const u of unsubs.splice(0)) {
        u();
      }
      ctx = undefined;
    },
    redactKeys(): string[] {
      return [];
    },
  };
}

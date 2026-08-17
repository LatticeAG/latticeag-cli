import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Adapter,
  AdapterContext,
  AdapterHealth,
  LatticeBus,
} from "@latticeag/bus";
import { newEnvelopeId } from "@latticeag/bus";
import type {
  BeliefExtractedPayload,
  BeliefType,
  JsonObject,
  Producer,
  ToolObservedPayload,
} from "@latticeag/events";

export const ADAPTER_VERSION = "0.1.0";
export const ADAPTER_ID = "axion";

const PRODUCER: Producer = {
  product: "axion",
  adapter: "@latticeag/adapter-axion",
  adapter_version: ADAPTER_VERSION,
};

const BELIEF_TYPES = new Set<BeliefType>([
  "causal",
  "assumption",
  "intention",
  "evidence",
  "uncertainty",
  "contradiction",
  "planning",
  "self-correction",
]);

export interface AxionExtractedBelief {
  id: string;
  sessionId?: string;
  type: BeliefType;
  belief: string;
  evidence?: string;
  confidence: number;
  actionTaken?: string;
  timestamp: number;
  line: number;
  rawText?: string;
}

export interface AxionObservedAction {
  id: string;
  name: string;
  provider: "openai" | "anthropic";
  source: "tool_calls" | "tool_use";
  argumentFingerprint: string;
  argumentFingerprintSource: "canonical" | "raw";
  argumentBytes: number;
  sourceClass: "tool_observed";
  argumentsRedacted?: string;
  arguments?: JsonObject;
}

export interface BeliefBatchWebhookPayload {
  spec: "axion.belief_batch.v1";
  sessionId: string;
  timestamp: number;
  provider?: "openai" | "anthropic";
  modelName?: string;
  callsInSession: number;
  inboundMessageCount?: number;
  beliefs: AxionExtractedBelief[];
  actions: AxionObservedAction[];
  redactions: number;
}

export type IngestRequest = IncomingMessage & { rawBody?: Buffer };

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeEqualHex(provided: string, expected: string): boolean {
  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || a.length === 0) {
      return false;
    }
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function verifyAxionSignature(
  rawBody: Buffer | string,
  secret: string,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) {
    return false;
  }
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqualHex(provided, expected);
}

export function signAxionBody(secret: string, rawBody: string | Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function isBeliefType(value: unknown): value is BeliefType {
  return typeof value === "string" && BELIEF_TYPES.has(value as BeliefType);
}

function parseBelief(value: unknown): AxionExtractedBelief | undefined {
  if (!isRecord(value) || typeof value.id !== "string") {
    return undefined;
  }
  if (!isBeliefType(value.type) || typeof value.belief !== "string") {
    return undefined;
  }
  const confidence =
    typeof value.confidence === "number" ? value.confidence : 0;
  const timestamp =
    typeof value.timestamp === "number" ? value.timestamp : Date.now();
  const line = typeof value.line === "number" ? value.line : 1;
  const out: AxionExtractedBelief = {
    id: value.id,
    type: value.type,
    belief: value.belief,
    confidence,
    timestamp,
    line,
  };
  if (typeof value.sessionId === "string") {
    out.sessionId = value.sessionId;
  }
  if (typeof value.evidence === "string") {
    out.evidence = value.evidence;
  }
  if (typeof value.actionTaken === "string") {
    out.actionTaken = value.actionTaken;
  }
  if (typeof value.rawText === "string") {
    out.rawText = value.rawText;
  }
  return out;
}

function parseAction(value: unknown): AxionObservedAction | undefined {
  if (!isRecord(value) || typeof value.id !== "string") {
    return undefined;
  }
  if (typeof value.name !== "string") {
    return undefined;
  }
  const provider =
    value.provider === "anthropic" || value.provider === "openai"
      ? value.provider
      : "openai";
  const source =
    value.source === "tool_use" || value.source === "tool_calls"
      ? value.source
      : "tool_calls";
  const out: AxionObservedAction = {
    id: value.id,
    name: value.name,
    provider,
    source,
    argumentFingerprint:
      typeof value.argumentFingerprint === "string"
        ? value.argumentFingerprint
        : "",
    argumentFingerprintSource:
      value.argumentFingerprintSource === "raw" ? "raw" : "canonical",
    argumentBytes:
      typeof value.argumentBytes === "number" ? value.argumentBytes : 0,
    sourceClass: "tool_observed",
  };
  if (typeof value.argumentsRedacted === "string") {
    out.argumentsRedacted = value.argumentsRedacted;
  }
  if (isRecord(value.arguments)) {
    out.arguments = value.arguments as JsonObject;
  }
  return out;
}

export function parseBeliefBatch(value: unknown): BeliefBatchWebhookPayload | undefined {
  if (!isRecord(value) || !Array.isArray(value.beliefs)) {
    return undefined;
  }
  const beliefs = value.beliefs
    .map(parseBelief)
    .filter((b): b is AxionExtractedBelief => b !== undefined);
  const actions = Array.isArray(value.actions)
    ? value.actions
        .map(parseAction)
        .filter((a): a is AxionObservedAction => a !== undefined)
    : [];
  return {
    spec: "axion.belief_batch.v1",
    sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
    timestamp: typeof value.timestamp === "number" ? value.timestamp : Date.now(),
    ...(value.provider === "openai" || value.provider === "anthropic"
      ? { provider: value.provider }
      : {}),
    ...(typeof value.modelName === "string" ? { modelName: value.modelName } : {}),
    callsInSession:
      typeof value.callsInSession === "number" ? value.callsInSession : 0,
    ...(typeof value.inboundMessageCount === "number"
      ? { inboundMessageCount: value.inboundMessageCount }
      : {}),
    beliefs,
    actions,
    redactions: typeof value.redactions === "number" ? value.redactions : 0,
  };
}

function batchObject(payload: BeliefBatchWebhookPayload): BeliefExtractedPayload["batch"] {
  return {
    spec: "axion.belief_batch.v1",
    calls_in_session: payload.callsInSession,
    ...(payload.provider !== undefined ? { provider: payload.provider } : {}),
    ...(payload.modelName !== undefined ? { model_name: payload.modelName } : {}),
    ...(payload.inboundMessageCount !== undefined
      ? { inbound_message_count: payload.inboundMessageCount }
      : {}),
    redactions: payload.redactions,
  };
}

function beliefPayload(
  item: AxionExtractedBelief,
  batch: BeliefExtractedPayload["batch"],
): BeliefExtractedPayload {
  return {
    belief: {
      id: item.id,
      type: item.type,
      text: item.belief,
      ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
      confidence: item.confidence,
      ...(item.actionTaken !== undefined ? { action_taken: item.actionTaken } : {}),
      line: item.line,
      axion_timestamp_ms: item.timestamp,
    },
    batch,
  };
}

function toolPayload(action: AxionObservedAction): ToolObservedPayload {
  return {
    source: "axion",
    name: action.name,
    arguments: action.arguments ?? {},
    ...(action.argumentFingerprint
      ? { argument_fingerprint: action.argumentFingerprint }
      : {}),
    axion_action_id: action.id,
  };
}

export async function emitBeliefBatch(
  bus: LatticeBus,
  payload: BeliefBatchWebhookPayload,
  seenBeliefIds?: Set<string>,
  seenActionIds?: Set<string>,
): Promise<number> {
  const batch = batchObject(payload);
  const beliefs = payload.beliefs.filter((item) => {
    if (!seenBeliefIds) {
      return true;
    }
    if (seenBeliefIds.has(item.id)) {
      return false;
    }
    seenBeliefIds.add(item.id);
    return true;
  });
  const actions = payload.actions.filter((item) => {
    if (!seenActionIds) {
      return true;
    }
    if (seenActionIds.has(item.id)) {
      return false;
    }
    seenActionIds.add(item.id);
    return true;
  });

  const ids = beliefs.map(() => newEnvelopeId());
  const causationId = ids[0];
  let emitted = 0;

  for (let i = 0; i < beliefs.length; i++) {
    const item = beliefs[i];
    const id = ids[i];
    if (!item || !id) {
      continue;
    }
    await bus.emit({
      name: "belief_extracted",
      id,
      ...(causationId !== undefined ? { causation_id: causationId } : {}),
      correlation_id: bus.run_id,
      producer: PRODUCER,
      payload: beliefPayload(item, batch),
    });
    emitted += 1;
  }

  for (const action of actions) {
    await bus.emit({
      name: "tool_observed",
      ...(causationId !== undefined ? { causation_id: causationId } : {}),
      correlation_id: bus.run_id,
      producer: PRODUCER,
      payload: toolPayload(action),
    });
    emitted += 1;
  }

  return emitted;
}

async function emitFixture(ctx: AdapterContext, path: string): Promise<void> {
  const raw = readFileSync(path, "utf8");
  const parsed = parseBeliefBatch(JSON.parse(raw) as unknown);
  if (!parsed) {
    throw new Error(`invalid fixture beliefs at ${path}`);
  }
  await emitBeliefBatch(ctx.bus, parsed);
}

function fixturePath(ctx: AdapterContext): string | undefined {
  const fromEnv =
    ctx.env.LATTICEAG_FIXTURE_BELIEFS ?? process.env.LATTICEAG_FIXTURE_BELIEFS;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  return undefined;
}

function rawBodyOf(req: IngestRequest): Buffer {
  if (req.rawBody) {
    return req.rawBody;
  }
  return Buffer.alloc(0);
}

export function createAdapter(): Adapter {
  let ctx: AdapterContext | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const seenBeliefIds = new Set<string>();
  const seenActionIds = new Set<string>();
  let lastHealth: AdapterHealth = {
    id: ADAPTER_ID,
    ok: false,
    detail: "not started",
  };

  async function handleIngest(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    if (!ctx) {
      json(res, 503, { ok: false, error: "not started" });
      return;
    }
    const env = ctx.env;
    const secret = env.AXION_WEBHOOK_SECRET ?? "";
    const allowUnsigned = env.AXION_WEBHOOK_ALLOW_UNSIGNED === "true";
    const signature = header(req, "x-axion-signature");
    const raw = rawBodyOf(req as IngestRequest);

    if (!signature) {
      if (!allowUnsigned) {
        json(res, 401, { ok: false, error: "unsigned webhook refused" });
        return;
      }
    } else {
      if (!secret || !verifyAxionSignature(raw, secret, signature)) {
        json(res, 401, { ok: false, error: "invalid signature" });
        return;
      }
    }

    const payload = parseBeliefBatch(body);
    if (!payload) {
      json(res, 400, { ok: false, error: "invalid belief batch" });
      return;
    }
    await emitBeliefBatch(ctx.bus, payload, seenBeliefIds, seenActionIds);
    json(res, 200, { ok: true });
  }

  async function pollOnce(): Promise<void> {
    if (!ctx) {
      return;
    }
    const base = ctx.config.adapters.axion.base_url.replace(/\/$/, "");
    const sessionId =
      ctx.env.LATTICEAG_SESSION_ID ?? ctx.bus.session_id;
    const token = ctx.env.AXION_READ_TOKEN ?? "";
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) {
      headers.authorization = `Bearer ${token}`;
      headers["x-axion-read-token"] = token;
    }
    const res = await fetch(`${base}/api/beliefs/${encodeURIComponent(sessionId)}`, {
      headers,
    });
    if (!res.ok) {
      return;
    }
    const body: unknown = await res.json();
    const payload = parseBeliefBatch(body);
    if (!payload) {
      return;
    }
    await emitBeliefBatch(ctx.bus, payload, seenBeliefIds, seenActionIds);
  }

  return {
    id: ADAPTER_ID,
    product: "axion",
    async start(startCtx: AdapterContext): Promise<void> {
      ctx = startCtx;
      seenBeliefIds.clear();
      seenActionIds.clear();
      const fixture = fixturePath(startCtx);
      if (fixture) {
        await emitFixture(startCtx, fixture);
      }
      const mode = startCtx.config.adapters.axion.mode;
      if (mode === "webhook") {
        startCtx.registerIngest("/axion", handleIngest);
      } else {
        const interval = startCtx.config.adapters.axion.poll_interval_ms;
        await pollOnce();
        pollTimer = setInterval(() => {
          void pollOnce();
        }, interval);
        if (typeof pollTimer === "object" && "unref" in pollTimer) {
          pollTimer.unref();
        }
      }
      lastHealth = { id: ADAPTER_ID, ok: true, detail: mode };
    },
    async health(): Promise<AdapterHealth> {
      if (!ctx) {
        return lastHealth;
      }
      const base = ctx.config.adapters.axion.base_url.replace(/\/$/, "");
      try {
        const res = await fetch(`${base}/api/health`);
        const body = (await res.json()) as { ok?: unknown };
        const ok = res.ok && body.ok === true;
        lastHealth = {
          id: ADAPTER_ID,
          ok,
          detail: ok ? `${base}/api/health` : `http ${res.status}`,
        };
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
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      ctx = undefined;
    },
    redactKeys(): string[] {
      return ["rawText", "argumentsRedacted"];
    },
  };
}

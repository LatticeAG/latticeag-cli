import {
  existsSync,
  mkdirSync,
  readFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { access, constants, mkdir } from "node:fs/promises";
import path from "node:path";
import { VisReplay } from "@latticeag/visreplay";
import type {
  Adapter,
  AdapterContext,
  AdapterHealth,
  LatticeBus,
} from "@latticeag/bus";
import type { LatticeagConfig } from "@latticeag/config";
import type {
  JsonObject,
  JsonValue,
  Producer,
  SessionRecordedPayload,
  ToolObservedPayload,
  VisReplayEventType,
} from "@latticeag/events";

export const ADAPTER_VERSION = "0.1.0";
export const ADAPTER_ID = "visreplay";
export const WATCH_DEBOUNCE_MS = 200;

const PRODUCER: Producer = {
  product: "visreplay",
  adapter: "@latticeag/adapter-visreplay",
  adapter_version: ADAPTER_VERSION,
};

const EVENT_TYPES: VisReplayEventType[] = [
  "input",
  "reasoning",
  "tool_call",
  "tool_result",
  "output",
  "error",
];

export interface WrapAgentContext {
  bus: LatticeBus;
  config: LatticeagConfig;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface VisReplayEvent {
  eventId: string;
  type: string;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  method?: string;
  content?: unknown;
}

interface VisReplaySessionLike {
  sessionId: string;
  sessionName: string;
  agentType: string;
  startedAt: string;
  endedAt?: string;
  events: VisReplayEvent[];
}

interface VisReplayLike {
  wrap<T extends object>(agent: T): T;
  getSession(): VisReplaySessionLike;
  save(filePath: string): Promise<void>;
  recordToolCall(name: string, args: Record<string, unknown>): unknown;
  recordToolResult(result: unknown): unknown;
  end(): VisReplaySessionLike;
}

const liveRecorders = new Set<{
  visReplay: VisReplayLike;
  ctx: WrapAgentContext;
  seen: Set<string>;
}>();

const emittedPaths = new Set<string>();
let activeCtx: AdapterContext | undefined;

function emptyCounts(): Record<VisReplayEventType, number> {
  const counts = {
    input: 0,
    reasoning: 0,
    tool_call: 0,
    tool_result: 0,
    output: 0,
    error: 0,
  } satisfies Record<VisReplayEventType, number>;
  return counts;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (t === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function asJsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value) && isJsonValue(value)) {
    return value as JsonObject;
  }
  if (isJsonValue(value)) {
    return { value };
  }
  return { value: String(value) };
}

function asJsonValue(value: unknown): JsonValue {
  if (isJsonValue(value)) {
    return value;
  }
  return String(value);
}

function argsObject(args: unknown[]): JsonObject {
  if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
    return asJsonObject(args[0]);
  }
  return { args: args.map(asJsonValue) };
}

function countEvents(events: VisReplayEvent[]): Record<VisReplayEventType, number> {
  const counts = emptyCounts();
  for (const event of events) {
    if ((EVENT_TYPES as string[]).includes(event.type)) {
      counts[event.type as VisReplayEventType] += 1;
    }
  }
  return counts;
}

function sessionPayload(
  session: VisReplaySessionLike,
  filePath: string,
): SessionRecordedPayload {
  const event_counts = countEvents(session.events);
  const event_count = Object.values(event_counts).reduce((sum, n) => sum + n, 0);
  return {
    visreplay_schema: "visreplay/session/1.0",
    visreplay_session_id: session.sessionId,
    session_name: session.sessionName,
    agent_type: session.agentType,
    started_at: session.startedAt,
    ...(session.endedAt !== undefined ? { ended_at: session.endedAt } : {}),
    path: filePath,
    event_count,
    event_counts,
  };
}

async function emitSessionRecorded(
  bus: LatticeBus,
  session: VisReplaySessionLike,
  filePath: string,
): Promise<void> {
  const abs = path.resolve(filePath);
  if (emittedPaths.has(abs)) {
    return;
  }
  emittedPaths.add(abs);
  await bus.emit({
    name: "session_recorded",
    producer: PRODUCER,
    correlation_id: bus.run_id,
    payload: sessionPayload(session, abs),
  });
}

async function emitNewTools(
  bus: LatticeBus,
  visReplay: VisReplayLike,
  seen: Set<string>,
): Promise<void> {
  const events = visReplay.getSession().events;
  for (const event of events) {
    if (seen.has(event.eventId)) {
      continue;
    }
    seen.add(event.eventId);
    if (event.type !== "tool_call" && event.type !== "tool_result") {
      continue;
    }
    const payload: ToolObservedPayload = {
      source: "visreplay",
      name: event.name ?? event.method ?? "unknown",
      arguments: asJsonObject(event.arguments ?? {}),
      visreplay_event_id: event.eventId,
    };
    if (event.result !== undefined) {
      payload.result = asJsonValue(event.result);
    }
    if (typeof event.error === "string") {
      payload.error = event.error;
    }
    await bus.emit({
      name: "tool_observed",
      producer: PRODUCER,
      correlation_id: bus.run_id,
      payload,
    });
  }
}

function observeThenable(
  value: unknown,
  onFulfilled: (result: unknown) => void,
  onRejected: (error: unknown) => void,
): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  const then = (value as { then?: unknown }).then;
  if (typeof then !== "function") {
    return false;
  }
  try {
    (then as (onF: (v: unknown) => void, onR: (e: unknown) => void) => unknown).call(
      value,
      onFulfilled,
      onRejected,
    );
  } catch (err) {
    onRejected(err);
  }
  return true;
}

function sessionDirOf(ctx: WrapAgentContext): string {
  return path.resolve(ctx.cwd, ctx.config.adapters.visreplay.session_dir);
}

/**
 * wrapAgent is ours. The VisReplay SDK method is `wrap`.
 * wrapAgent constructs VisReplay and calls visReplay.wrap(agent).
 */
export function wrapAgent<T extends object>(agent: T, ctx: WrapAgentContext): T {
  const visReplay = new VisReplay({
    sessionName: ctx.bus.run_id,
    agentType: ctx.config.adapters.visreplay.agent_type,
  }) as unknown as VisReplayLike;
  const seen = new Set<string>();
  liveRecorders.add({ visReplay, ctx, seen });

  const inner = visReplay.wrap(agent);
  const handler: ProxyHandler<T> = {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver);
      if (typeof original !== "function") {
        return original;
      }
      return function wrappedMethod(this: unknown, ...args: unknown[]): unknown {
        const method = String(property);
        visReplay.recordToolCall(method, argsObject(args));
        let result: unknown;
        try {
          result = Reflect.apply(original as (...a: unknown[]) => unknown, target, args);
        } catch (error) {
          visReplay.recordToolResult({
            error: error instanceof Error ? error.message : String(error),
          });
          void emitNewTools(ctx.bus, visReplay, seen);
          throw error;
        }
        const finish = (value: unknown) => {
          visReplay.recordToolResult(value);
          void emitNewTools(ctx.bus, visReplay, seen);
        };
        if (observeThenable(result, finish, finish)) {
          return result;
        }
        finish(result);
        return result;
      };
    },
  };
  return new Proxy(inner, handler);
}

function parseSessionFile(filePath: string): VisReplaySessionLike | undefined {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (typeof raw.sessionId !== "string" || !Array.isArray(raw.events)) {
      return undefined;
    }
    return {
      sessionId: raw.sessionId,
      sessionName: typeof raw.sessionName === "string" ? raw.sessionName : "",
      agentType: typeof raw.agentType === "string" ? raw.agentType : "custom",
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : new Date().toISOString(),
      ...(typeof raw.endedAt === "string" ? { endedAt: raw.endedAt } : {}),
      events: raw.events as VisReplayEvent[],
    };
  } catch {
    return undefined;
  }
}

export function createAdapter(): Adapter {
  let watcher: FSWatcher | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let lastHealth: AdapterHealth = {
    id: ADAPTER_ID,
    ok: false,
    detail: "not started",
  };

  return {
    id: ADAPTER_ID,
    product: "visreplay",
    async start(ctx: AdapterContext): Promise<void> {
      activeCtx = ctx;
      emittedPaths.clear();
      liveRecorders.clear();
      const dir = sessionDirOf(ctx);
      await mkdir(dir, { recursive: true });
      watcher = watch(dir, (event, filename) => {
        if (!filename || !String(filename).endsWith(".vrs")) {
          return;
        }
        if (debounce) {
          clearTimeout(debounce);
        }
        debounce = setTimeout(() => {
          const filePath = path.join(dir, String(filename));
          if (!existsSync(filePath) || !activeCtx) {
            return;
          }
          const session = parseSessionFile(filePath);
          if (!session) {
            return;
          }
          void emitSessionRecorded(activeCtx.bus, session, filePath);
        }, WATCH_DEBOUNCE_MS);
        if (typeof debounce === "object" && "unref" in debounce) {
          debounce.unref();
        }
      });
      lastHealth = { id: ADAPTER_ID, ok: true, detail: dir };
    },
    async health(): Promise<AdapterHealth> {
      if (!activeCtx) {
        return lastHealth;
      }
      const dir = sessionDirOf(activeCtx);
      try {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        await access(dir, constants.W_OK);
        lastHealth = { id: ADAPTER_ID, ok: true, detail: dir };
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
      if (debounce) {
        clearTimeout(debounce);
        debounce = undefined;
      }
      watcher?.close();
      watcher = undefined;
      for (const rec of liveRecorders) {
        const dir = sessionDirOf(rec.ctx);
        mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${rec.ctx.bus.run_id}.vrs`);
        rec.visReplay.end();
        await rec.visReplay.save(filePath);
        await emitSessionRecorded(rec.ctx.bus, rec.visReplay.getSession(), filePath);
      }
      liveRecorders.clear();
      activeCtx = undefined;
    },
    redactKeys(): string[] {
      return [];
    },
  };
}

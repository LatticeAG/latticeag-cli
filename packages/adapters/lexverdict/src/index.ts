import { createHash } from "node:crypto";
import type {
  Adapter,
  AdapterContext,
  AdapterHealth,
} from "@latticeag/bus";
import type {
  AnyLatticeEvent,
  Producer,
  ToolObservedEvent,
  VerdictPayload,
} from "@latticeag/events";

export const ADAPTER_VERSION = "0.1.0";
export const ADAPTER_ID = "lexverdict";
export const MAX_VERIFICATION_FIELD_CHARS = 8000;

const PRODUCER: Producer = {
  product: "lexverdict",
  adapter: "@latticeag/adapter-lexverdict",
  adapter_version: ADAPTER_VERSION,
};

export function sha256Utf8Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fieldTooLong(...fields: string[]): boolean {
  return fields.some((f) => f.length > MAX_VERIFICATION_FIELD_CHARS);
}

export function createAdapter(): Adapter {
  let ctx: AdapterContext | undefined;
  let unsubscribe: (() => void) | undefined;
  const seen = new Set<string>();
  let lastHealth: AdapterHealth = {
    id: ADAPTER_ID,
    ok: false,
    detail: "not started",
  };

  async function onToolObserved(event: AnyLatticeEvent): Promise<void> {
    if (!ctx || event.name !== "tool_observed") {
      return;
    }
    if (seen.has(event.id)) {
      return;
    }
    seen.add(event.id);
    const payload = (event as ToolObservedEvent).payload;
    const tool_call = `${payload.name} ${JSON.stringify(payload.arguments)}`;
    const goal = ctx.env.LATTICEAG_GOAL ?? "complete the user task";
    const result = JSON.stringify(payload.result ?? payload.error);
    if (fieldTooLong(tool_call, goal, result)) {
      await ctx.bus.emit({
        name: "adapter_error",
        producer: PRODUCER,
        correlation_id: event.correlation_id,
        causation_id: event.id,
        payload: {
          adapter: "@latticeag/adapter-lexverdict",
          message: `verification field exceeds ${MAX_VERIFICATION_FIELD_CHARS} chars`,
          event_id: event.id,
        },
      });
      return;
    }
    const base = (ctx.env.LEXVERDICT_URL ?? "").replace(/\/$/, "");
    const timeoutMs = ctx.config.adapters.lexverdict.timeout_ms;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(`${base}/v1/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool_call, goal, result }),
        signal: ac.signal,
      });
      const body = (await res.json()) as {
        verdict?: unknown;
        confidence?: unknown;
        message?: unknown;
      };
      const verdict: VerdictPayload["verdict"] =
        body.verdict === "steer" ? "steer" : "pass";
      const mapped: VerdictPayload = {
        verdict,
        confidence: typeof body.confidence === "number" ? body.confidence : 0,
        message: typeof body.message === "string" || body.message === null
          ? (body.message as string | null)
          : null,
        tool_call,
        goal,
        result,
        tool_call_sha256: sha256Utf8Hex(tool_call),
        goal_sha256: sha256Utf8Hex(goal),
        result_sha256: sha256Utf8Hex(result),
        latency_ms: Date.now() - started,
      };
      await ctx.bus.emit({
        name: "verdict",
        producer: PRODUCER,
        correlation_id: event.correlation_id,
        causation_id: event.id,
        payload: mapped,
      });
    } catch (err) {
      await ctx.bus.emit({
        name: "adapter_error",
        producer: PRODUCER,
        correlation_id: event.correlation_id,
        causation_id: event.id,
        payload: {
          adapter: "@latticeag/adapter-lexverdict",
          message: err instanceof Error ? err.message : String(err),
          cause_name: err instanceof Error ? err.name : undefined,
          event_id: event.id,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: ADAPTER_ID,
    product: "lexverdict",
    async start(startCtx: AdapterContext): Promise<void> {
      const url = startCtx.env.LEXVERDICT_URL;
      if (!url || url.trim().length === 0) {
        throw new Error("LEXVERDICT_URL unset");
      }
      ctx = startCtx;
      seen.clear();
      unsubscribe = startCtx.bus.subscribe("tool_observed", (event) => {
        void onToolObserved(event);
      });
      lastHealth = { id: ADAPTER_ID, ok: true, detail: url };
    },
    async health(): Promise<AdapterHealth> {
      if (!ctx) {
        return lastHealth;
      }
      const base = (ctx.env.LEXVERDICT_URL ?? "").replace(/\/$/, "");
      try {
        const res = await fetch(`${base}/health`);
        const body = (await res.json()) as { status?: unknown };
        const status = typeof body.status === "string" ? body.status : undefined;
        const ok =
          res.ok &&
          (status === "ok" || status === "degraded" || status === undefined);
        lastHealth = {
          id: ADAPTER_ID,
          ok,
          detail: status ?? `http ${res.status}`,
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
      unsubscribe?.();
      unsubscribe = undefined;
      ctx = undefined;
    },
    redactKeys(): string[] {
      return [];
    },
  };
}

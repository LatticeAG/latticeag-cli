import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ulid } from "ulid";
import type { BeliefExtractedEvent, BeliefType } from "@latticeag/events";
import { InspectTextUnsupportedError, LatticeAGError } from "../errors.js";
import {
  isWebhookBatch,
  mapActionsToToolObservedPartials,
  mapBeliefBatchToPartials,
  mapInspectBeliefsToPartials,
} from "../integration/mappers.js";
import type { InspectBelief, InspectInput } from "../types.js";
import type { StageExecuteContext } from "./types.js";

const BELIEF_TYPES: [BeliefType, ...BeliefType[]] = [
  "causal",
  "assumption",
  "intention",
  "evidence",
  "uncertainty",
  "contradiction",
  "planning",
  "self-correction",
];

const inspectBeliefSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(BELIEF_TYPES),
    text: z.string(),
    evidence: z.string().optional(),
    confidence: z.number().min(0).max(1),
    action_taken: z.string().optional(),
    line: z.number().int(),
    axion_timestamp_ms: z.number(),
  })
  .strict();

export const inspectInputSchema: z.ZodType<InspectInput> = z.discriminatedUnion("source", [
  z.object({ source: z.literal("fixture"), path: z.string().min(1).optional() }).strict(),
  z.object({ source: z.literal("session"), session_id: z.string().min(1).optional() }).strict(),
  z
    .object({
      source: z.literal("beliefs"),
      beliefs: z.array(inspectBeliefSchema).min(1),
      batch: z
        .object({
          spec: z.literal("axion.belief_batch.v1"),
          calls_in_session: z.number().int(),
          provider: z.enum(["openai", "anthropic"]).optional(),
          model_name: z.string().optional(),
          inbound_message_count: z.number().int().optional(),
          redactions: z.number().int(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("text"),
      text: z.string(),
      turns_ago: z.number().int().optional(),
    })
    .strict(),
]);

export const AXION_PRODUCER = {
  product: "axion" as const,
  adapter: "@latticeag/adapter-axion",
  adapter_version: "0.1.0",
};

export async function executeInspect(
  input: InspectInput,
  ctx: StageExecuteContext,
  seenBeliefIds: Set<string>,
): Promise<BeliefExtractedEvent[]> {
  const parsed = inspectInputSchema.parse(input);
  if (parsed.source !== "fixture" && parsed.source !== "beliefs" && !ctx.config.adapters.axion.enabled) {
    throw new LatticeAGError("STAGE_DISABLED", "adapters.axion.enabled is false");
  }

  if (parsed.source === "text") {
    const modPath = ctx.env.LATTICEAG_AXION_EXTRACT_MODULE;
    if (!modPath) {
      throw new InspectTextUnsupportedError(
        "INSPECT_TEXT_UNSUPPORTED",
        "inspect({ source: \"text\" }) requires LATTICEAG_AXION_EXTRACT_MODULE",
      );
    }
    let extracted: unknown;
    try {
      const href = modPath.startsWith("file:") ? modPath : pathToFileURL(modPath).href;
      const mod = (await import(href)) as {
        extractBeliefs?: (text: string, opts: { sessionId: string; turnsAgo?: number }) => Promise<unknown>;
      };
      if (typeof mod.extractBeliefs !== "function") {
        throw new Error("missing extractBeliefs");
      }
      extracted = await mod.extractBeliefs(parsed.text, {
        sessionId: ctx.session_id,
        turnsAgo: parsed.turns_ago,
      });
    } catch (err) {
      throw new InspectTextUnsupportedError(
        "INSPECT_TEXT_UNSUPPORTED",
        "extract module missing or has no extractBeliefs export",
        { cause: err },
      );
    }
    const beliefs = normalizeExtracted(extracted);
    return emitBeliefs(beliefs, defaultBatch(), ctx, seenBeliefIds);
  }

  if (parsed.source === "beliefs") {
    const batch = parsed.batch ?? defaultBatch();
    const partials = mapInspectBeliefsToPartials(parsed.beliefs, batch);
    return emitPartials(partials, ctx, seenBeliefIds);
  }

  if (parsed.source === "session") {
    const sessionId = parsed.session_id ?? ctx.session_id;
    const base = ctx.config.adapters.axion.base_url.replace(/\/$/, "");
    const url = `${base}/api/beliefs/${sessionId}`;
    const headers: Record<string, string> = {};
    const token = ctx.env.AXION_READ_TOKEN;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      headers["x-axion-read-token"] = token;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.backend.timeout_ms);
    let body: unknown;
    try {
      const res = await fetch(url, { headers, signal: ctx.abort.aborted ? ctx.abort : controller.signal });
      body = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const batch = isWebhookBatch(body) ? body : undefined;
    if (!batch) {
      return [];
    }
    const fresh = batch.beliefs.filter((b) => !seenBeliefIds.has(b.id));
    if (fresh.length === 0) {
      return [];
    }
    return emitPartials(mapBeliefBatchToPartials({ ...batch, beliefs: fresh }), ctx, seenBeliefIds);
  }

  const path = parsed.path
    ? isAbsolute(parsed.path)
      ? parsed.path
      : join(ctx.cwd, parsed.path)
    : ctx.backend.kind === "fixture"
      ? ctx.backend.detail
      : undefined;
  if (!path) {
    throw new LatticeAGError("STAGE_BACKEND", "inspect fixture path missing");
  }
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (isWebhookBatch(raw)) {
    const beliefs = await emitPartials(mapBeliefBatchToPartials(raw), ctx, seenBeliefIds);
    if (raw.actions && raw.actions.length > 0) {
      const tools = mapActionsToToolObservedPartials(raw.actions);
      for (const tool of tools) {
        await ctx.bus.emit({
          name: "tool_observed",
          payload: tool.payload,
          producer: AXION_PRODUCER,
          correlation_id: ctx.run_id,
          causation_id: beliefs[0]?.id,
        });
      }
    }
    return beliefs;
  }
  const file = raw as { beliefs: InspectBelief[]; actions?: unknown[]; batch?: BeliefExtractedEvent["payload"]["batch"] };
  const batch = file.batch ?? defaultBatch();
  return emitPartials(mapInspectBeliefsToPartials(file.beliefs, batch), ctx, seenBeliefIds);
}

function defaultBatch(): BeliefExtractedEvent["payload"]["batch"] {
  return {
    spec: "axion.belief_batch.v1",
    calls_in_session: 1,
    redactions: 0,
  };
}

function normalizeExtracted(extracted: unknown): InspectBelief[] {
  if (!Array.isArray(extracted)) {
    return [];
  }
  return extracted.map((row, index) => {
    const rec = row as {
      id?: string;
      type?: BeliefType;
      belief?: { text?: string; type?: BeliefType; id?: string };
      text?: string;
      confidence?: number;
      actionTaken?: string;
      timestamp?: number;
      line?: number;
    };
    const text = rec.belief?.text ?? rec.text ?? "";
    return {
      id: rec.id ?? rec.belief?.id ?? `extract-${index}`,
      type: rec.type ?? rec.belief?.type ?? "assumption",
      text,
      confidence: rec.confidence ?? 0,
      line: rec.line ?? 0,
      axion_timestamp_ms: rec.timestamp ?? Date.now(),
      ...(rec.actionTaken !== undefined ? { action_taken: rec.actionTaken } : {}),
    };
  });
}

async function emitBeliefs(
  beliefs: InspectBelief[],
  batch: BeliefExtractedEvent["payload"]["batch"],
  ctx: StageExecuteContext,
  seen: Set<string>,
): Promise<BeliefExtractedEvent[]> {
  return emitPartials(mapInspectBeliefsToPartials(beliefs, batch), ctx, seen);
}

async function emitPartials(
  partials: ReturnType<typeof mapBeliefBatchToPartials>,
  ctx: StageExecuteContext,
  seen: Set<string>,
): Promise<BeliefExtractedEvent[]> {
  const events: BeliefExtractedEvent[] = [];
  const firstId = ulid();
  let index = 0;
  for (const partial of partials) {
    if (seen.has(partial.payload.belief.id)) {
      continue;
    }
    seen.add(partial.payload.belief.id);
    const event = (await ctx.bus.emit({
      ...(index === 0 ? { id: firstId } : {}),
      name: "belief_extracted",
      payload: partial.payload,
      producer: AXION_PRODUCER,
      correlation_id: ctx.run_id,
      causation_id: firstId,
    })) as BeliefExtractedEvent;
    events.push(event);
  }
  return events;
}

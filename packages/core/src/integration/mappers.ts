/**
 * Backwards-compat re-exports. Canonical definitions live in the adapter
 * packages' map.ts files. Spec C1: core does not copy mapping functions.
 */
export {
  mapBeliefBatchToPartials,
  mapActionsToToolObservedPartials,
  type BeliefBatchWebhookPayload,
} from "@latticeag/adapter-axion/map";
export {
  sha256Utf8Hex,
  sha256BytesHex,
  toVerifyBody,
  fromVerdictResponse,
} from "@latticeag/adapter-lexverdict/map";
export {
  idempotencyKey,
  toCreateRequestInput,
  fromApprovedRequest,
  type ApprovedRequest,
} from "@latticeag/adapter-vekinbox/map";
export {
  diffSessionEvents,
  toSessionRecordedPayload,
  emptyEventCounts,
  type VisReplaySessionEvent,
} from "@latticeag/adapter-visreplay/map";

import type { BeliefExtractedPayload, JsonObject } from "@latticeag/events";
import type { InspectBelief } from "../types.js";
import type { BeliefBatchWebhookPayload } from "@latticeag/adapter-axion/map";

export interface CoreBeliefFile {
  beliefs: InspectBelief[];
  actions?: Array<{
    id: string;
    name: string;
    arguments?: JsonObject;
    argumentFingerprint?: string;
  }>;
  batch?: BeliefExtractedPayload["batch"];
}

export function mapInspectBeliefsToPartials(
  beliefs: InspectBelief[],
  batch: BeliefExtractedPayload["batch"],
): Array<{ name: "belief_extracted"; payload: BeliefExtractedPayload }> {
  return beliefs.map((item) => ({
    name: "belief_extracted" as const,
    payload: {
      belief: {
        id: item.id,
        type: item.type,
        text: item.text,
        ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
        confidence: item.confidence,
        ...(item.action_taken !== undefined ? { action_taken: item.action_taken } : {}),
        line: item.line,
        axion_timestamp_ms: item.axion_timestamp_ms,
      },
      batch,
    },
  }));
}

export function isWebhookBatch(value: unknown): value is BeliefBatchWebhookPayload {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return rec.spec === "axion.belief_batch.v1" && Array.isArray(rec.beliefs);
}

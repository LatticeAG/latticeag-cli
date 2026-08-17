/**
 * Axion mapping functions: axion.belief_batch.v1 payloads to lattice partials.
 */
import type {
  BeliefExtractedPayload,
  ToolObservedPayload,
} from "@latticeag/events";

export interface BeliefBatchWebhookPayload {
  spec: "axion.belief_batch.v1";
  sessionId: string;
  timestamp: number;
  provider?: "openai" | "anthropic";
  modelName?: string;
  callsInSession: number;
  inboundMessageCount?: number;
  redactions: number;
  beliefs: Array<{
    id: string;
    sessionId?: string;
    type: BeliefExtractedPayload["belief"]["type"];
    belief: string;
    evidence?: string;
    confidence: number;
    timestamp: number;
    line: number;
    actionTaken?: string;
    rawText?: string;
  }>;
  actions?: Array<{
    id: string;
    name: string;
    provider: "openai" | "anthropic";
    source: "tool_calls" | "tool_use";
    argumentFingerprint: string;
    argumentFingerprintSource: "canonical" | "raw";
    argumentBytes: number;
    sourceClass: "tool_observed";
    arguments?: ToolObservedPayload["arguments"];
  }>;
}

function batchFromWebhook(batch: BeliefBatchWebhookPayload): BeliefExtractedPayload["batch"] {
  return {
    spec: "axion.belief_batch.v1",
    calls_in_session: batch.callsInSession,
    ...(batch.provider !== undefined ? { provider: batch.provider } : {}),
    ...(batch.modelName !== undefined ? { model_name: batch.modelName } : {}),
    ...(batch.inboundMessageCount !== undefined
      ? { inbound_message_count: batch.inboundMessageCount }
      : {}),
    redactions: batch.redactions,
  };
}

export function mapBeliefBatchToPartials(
  batch: BeliefBatchWebhookPayload,
): Array<{ name: "belief_extracted"; payload: BeliefExtractedPayload }> {
  const shared = batchFromWebhook(batch);
  return batch.beliefs.map((item) => ({
    name: "belief_extracted" as const,
    payload: {
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
      batch: shared,
    },
  }));
}

export function mapActionsToToolObservedPartials(
  actions: NonNullable<BeliefBatchWebhookPayload["actions"]>,
): Array<{ name: "tool_observed"; payload: ToolObservedPayload }> {
  return actions.map((action) => ({
    name: "tool_observed" as const,
    payload: {
      source: "axion",
      name: action.name,
      arguments: action.arguments ?? {},
      argument_fingerprint: action.argumentFingerprint,
      axion_action_id: action.id,
    },
  }));
}

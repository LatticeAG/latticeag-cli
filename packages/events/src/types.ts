/**
 * Canonical LatticeAG event types. Source of truth for @latticeag/events.
 * Zod in zod.ts must accept exactly these types.
 *
 * Constraints (enforced in Zod, restated here):
 * - id ULID /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/
 * - seq integer >= 1
 * - ts ISO-8601 UTC ms, example 2026-08-17T13:57:00.123Z, must end with Z
 * - adapter starts with @latticeag/ or equals latticeag-internal
 * - $schema latticeag.events/1.0
 * - schema_version: 1
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export const LATTICEAG_EVENTS_SCHEMA = "latticeag.events/1.0" as const;

export const EVENT_NAMES = [
  "belief_extracted",
  "policy_decision",
  "verdict",
  "approval_granted",
  "compensation_executed",
  "receipt_issued",
  "session_recorded",
  "diff_computed",
  "tool_observed",
  "extension",
  "bus_overflow",
  "adapter_error",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export const PRODUCT_SLUGS = [
  "polybrain",
  "polygnosis",
  "polyflow",
  "polyscribe",
  "polymesh",
  "lexgateway",
  "lexrouter",
  "lexrapid",
  "lexshield",
  "lexverdict",
  "vektor",
  "vekdata",
  "vekinbox",
  "axicontext",
  "axion",
  "visboard",
  "viscompile",
  "visreplay",
  "forgedistill",
  "latticeag",
] as const;

export type ProductSlug = (typeof PRODUCT_SLUGS)[number];

export interface Producer {
  product: ProductSlug;
  adapter: string;
  adapter_version: string;
}

export interface RedactionStamp {
  applied: boolean;
  keys: string[];
  pattern_hits: number;
}

export interface EnvelopeBase {
  $schema: typeof LATTICEAG_EVENTS_SCHEMA;
  schema_version: 1;
  id: string;
  seq: number;
  ts: string;
  run_id: string;
  session_id: string;
  producer: Producer;
  causation_id?: string;
  correlation_id: string;
  redaction: RedactionStamp;
}

export interface Envelope<N extends EventName, P> extends EnvelopeBase {
  name: N;
  payload: P;
}

export type BeliefType =
  | "causal"
  | "assumption"
  | "intention"
  | "evidence"
  | "uncertainty"
  | "contradiction"
  | "planning"
  | "self-correction";

export interface BeliefExtractedPayload {
  belief: {
    id: string;
    type: BeliefType;
    text: string;
    evidence?: string;
    confidence: number;
    action_taken?: string;
    line: number;
    axion_timestamp_ms: number;
  };
  batch: {
    spec: "axion.belief_batch.v1";
    calls_in_session: number;
    provider?: "openai" | "anthropic";
    model_name?: string;
    inbound_message_count?: number;
    redactions: number;
  };
  action?: {
    id: string;
    name: string;
    provider: "openai" | "anthropic";
    source: "tool_calls" | "tool_use";
    argument_fingerprint: string;
    argument_fingerprint_source: "canonical" | "raw";
    argument_bytes: number;
    source_class: "tool_observed";
  };
}

export type BeliefExtractedEvent = Envelope<"belief_extracted", BeliefExtractedPayload>;

export type ShieldDecision = "ALLOW" | "BLOCK" | "CHALLENGE" | "DEFER";

export interface PolicyDecisionPayload {
  request_id: string;
  decision: ShieldDecision;
  matched_rule_id?: string;
  reason: string;
  policy_version?: string;
  duration_ms: number;
  challenge_id?: string;
  tool: { name: string; namespace?: string; version?: string };
  classifications: Array<{
    intent: string;
    confidence: number;
    classifier: string;
    alternatives: Array<{ intent: string; confidence: number }>;
  }>;
}

export type PolicyDecisionEvent = Envelope<"policy_decision", PolicyDecisionPayload>;

export type LexVerdictValue = "pass" | "steer";

export interface VerdictPayload {
  verdict: LexVerdictValue;
  confidence: number;
  message: string | null;
  tool_call: string;
  goal: string;
  result: string;
  tool_call_sha256: string;
  goal_sha256: string;
  result_sha256: string;
  latency_ms: number;
}

export type VerdictEvent = Envelope<"verdict", VerdictPayload>;

export type VekInboxStatus =
  | "pending"
  | "approved"
  | "declined"
  | "timed_out"
  | "escalated"
  | "cancelled"
  | "changes_requested";

export interface ApprovalGrantedPayload {
  request_id: string;
  key: string;
  title: string;
  workspace_id: string;
  agent_id: string;
  status: "approved";
  action: string;
  resolved_by?: string;
  resolved_at: string;
  note?: string;
  priority: "low" | "normal" | "high" | "critical";
}

export type ApprovalGrantedEvent = Envelope<"approval_granted", ApprovalGrantedPayload>;

export interface CompensationExecutedPayload {
  request_id: string;
  execution_id: string;
  state_from: "compensation_required";
  state_to: "failed_verified" | "invalidated" | "executed";
  action: string;
  note?: string;
  /** Spec 14.4: adapter output carries source so additionalProperties:false does not reject it. */
  source?: "metadata" | "fixture";
}

export type CompensationExecutedEvent = Envelope<
  "compensation_executed",
  CompensationExecutedPayload
>;

export type ReceiptTier =
  | "agent_asserted"
  | "gateway_verified"
  | "downstream_attested";

export interface ReceiptIssuedPayload {
  request_id: string;
  execution_id: string;
  tier: ReceiptTier;
  action: string;
  issued_at: string;
  payload_sha256: string;
  /** Spec 14.4: adapter output carries source so additionalProperties:false does not reject it. */
  source?: "metadata" | "fixture";
}

export type ReceiptIssuedEvent = Envelope<"receipt_issued", ReceiptIssuedPayload>;

export type VisReplayEventType =
  | "input"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "output"
  | "error";

export interface SessionRecordedPayload {
  visreplay_schema: "visreplay/session/1.0";
  visreplay_session_id: string;
  session_name: string;
  agent_type: string;
  started_at: string;
  ended_at?: string;
  path: string;
  event_count: number;
  event_counts: Record<VisReplayEventType, number>;
}

export type SessionRecordedEvent = Envelope<"session_recorded", SessionRecordedPayload>;

export type DiffCaseStatus =
  | "unchanged"
  | "added"
  | "removed"
  | "changed"
  | "improved";

export type WhyCode =
  | "case_added"
  | "case_removed"
  | "error_raised"
  | "error_resolved"
  | "input_changed"
  | "tool_call_reordered"
  | "tool_call_removed"
  | "tool_call_added"
  | "tool_call_arguments_changed"
  | "output_changed"
  | "error_changed";

export interface DiffComputedPayload {
  kind: "latticeag.viscompile.diff";
  viscompile_schema_version: 1 | 2;
  beliefs_omitted: boolean;
  baseline_path: string;
  target_path: string;
  report_path: string;
  summary: {
    unchanged: number;
    added: number;
    removed: number;
    changed: number;
    regressions: number;
    improvements: number;
  };
  cases: Array<{
    id: string;
    status: DiffCaseStatus;
    regression: boolean;
    why_codes: WhyCode[];
  }>;
  lattice_exit: 0 | 1 | 2;
}

export type DiffComputedEvent = Envelope<"diff_computed", DiffComputedPayload>;

export interface ToolObservedPayload {
  source: "axion" | "visreplay";
  name: string;
  arguments: JsonObject;
  result?: JsonValue;
  error?: string;
  argument_fingerprint?: string;
  visreplay_event_id?: string;
  axion_action_id?: string;
}

export type ToolObservedEvent = Envelope<"tool_observed", ToolObservedPayload>;

export interface ExtensionPayload {
  extension_name: string;
  payload: JsonValue;
}

export interface BusOverflowPayload {
  reason: "capacity" | "rotate" | "sync_outbox";
  dropped_id?: string;
  dropped_name?: string;
  ring_size: number;
  ring_capacity: number;
}

export interface AdapterErrorPayload {
  adapter: string;
  message: string;
  cause_name?: string;
  event_id?: string;
}

export type ExtensionEvent = Envelope<"extension", ExtensionPayload>;
export type BusOverflowEvent = Envelope<"bus_overflow", BusOverflowPayload>;
export type AdapterErrorEvent = Envelope<"adapter_error", AdapterErrorPayload>;

export type LatticeEvent =
  | BeliefExtractedEvent
  | PolicyDecisionEvent
  | VerdictEvent
  | ApprovalGrantedEvent
  | CompensationExecutedEvent
  | ReceiptIssuedEvent
  | SessionRecordedEvent
  | DiffComputedEvent
  | ToolObservedEvent
  | ExtensionEvent
  | BusOverflowEvent
  | AdapterErrorEvent;

export interface UnknownLatticeEvent extends EnvelopeBase {
  name: string;
  payload: JsonValue;
}

export type AnyLatticeEvent = LatticeEvent | UnknownLatticeEvent;

export interface PayloadMap {
  belief_extracted: BeliefExtractedPayload;
  policy_decision: PolicyDecisionPayload;
  verdict: VerdictPayload;
  approval_granted: ApprovalGrantedPayload;
  compensation_executed: CompensationExecutedPayload;
  receipt_issued: ReceiptIssuedPayload;
  session_recorded: SessionRecordedPayload;
  diff_computed: DiffComputedPayload;
  tool_observed: ToolObservedPayload;
  extension: ExtensionPayload;
  bus_overflow: BusOverflowPayload;
  adapter_error: AdapterErrorPayload;
}

export const MAX_ENVELOPE_BYTES = 262144;

export class EnvelopeTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(`JSON.stringify(envelope) exceeds ${MAX_ENVELOPE_BYTES} bytes: ${bytes}`);
    this.name = "EnvelopeTooLargeError";
    this.bytes = bytes;
  }
}

export class EventPayloadError extends Error {
  readonly pointer: string;

  constructor(message: string, pointer: string) {
    super(message);
    this.name = "EventPayloadError";
    this.pointer = pointer;
  }
}

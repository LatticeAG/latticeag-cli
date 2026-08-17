import { z } from "zod";
import {
  LATTICEAG_EVENTS_SCHEMA,
  PRODUCT_SLUGS,
  type EventName,
  type ProductSlug,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
} from "./types.js";

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const EXTENSION_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const TS_Z_RE = /Z$/;

const jsonPrimitiveSchema: z.ZodType<JsonPrimitive> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, jsonObjectSchema, z.array(jsonValueSchema)]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.lazy(() =>
  z.record(jsonValueSchema),
);

const productSlugSchema = z.enum(
  PRODUCT_SLUGS as unknown as [ProductSlug, ...ProductSlug[]],
);

const adapterSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith("@latticeag/") || value === "latticeag-internal",
    { message: "adapter must start with @latticeag/ or equal latticeag-internal" },
  );

const producerSchema = z
  .object({
    product: productSlugSchema,
    adapter: adapterSchema,
    adapter_version: z.string().min(1),
  })
  .strict();

const redactionStampSchema = z
  .object({
    applied: z.boolean(),
    keys: z.array(z.string()),
    pattern_hits: z.number().int().min(0),
  })
  .strict();

const envelopeFieldShape = {
  $schema: z.literal(LATTICEAG_EVENTS_SCHEMA),
  schema_version: z.literal(1),
  id: z.string().regex(ULID_RE),
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  ts: z.string().datetime({ offset: true }).regex(TS_Z_RE),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  producer: producerSchema,
  causation_id: z.string().min(1).optional(),
  correlation_id: z.string().min(1),
  redaction: redactionStampSchema,
};

export const envelopeBaseSchema = z
  .object({
    ...envelopeFieldShape,
    name: z.string().min(1),
    payload: jsonValueSchema,
  })
  .strict();

const beliefTypeSchema = z.enum([
  "causal",
  "assumption",
  "intention",
  "evidence",
  "uncertainty",
  "contradiction",
  "planning",
  "self-correction",
]);

export const beliefExtractedPayloadSchema = z
  .object({
    belief: z
      .object({
        id: z.string().min(1),
        type: beliefTypeSchema,
        text: z.string(),
        evidence: z.string().optional(),
        confidence: z.number().min(0).max(1),
        action_taken: z.string().optional(),
        line: z.number().int(),
        axion_timestamp_ms: z.number(),
      })
      .strict(),
    batch: z
      .object({
        spec: z.literal("axion.belief_batch.v1"),
        calls_in_session: z.number().int(),
        provider: z.enum(["openai", "anthropic"]).optional(),
        model_name: z.string().optional(),
        inbound_message_count: z.number().int().optional(),
        redactions: z.number().int(),
      })
      .strict(),
    action: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        provider: z.enum(["openai", "anthropic"]),
        source: z.enum(["tool_calls", "tool_use"]),
        argument_fingerprint: z.string(),
        argument_fingerprint_source: z.enum(["canonical", "raw"]),
        argument_bytes: z.number().int(),
        source_class: z.literal("tool_observed"),
      })
      .strict()
      .optional(),
  })
  .strict();

const shieldDecisionSchema = z.enum(["ALLOW", "BLOCK", "CHALLENGE", "DEFER"]);

export const policyDecisionPayloadSchema = z
  .object({
    request_id: z.string().min(1),
    decision: shieldDecisionSchema,
    matched_rule_id: z.string().optional(),
    reason: z.string(),
    policy_version: z.string().optional(),
    duration_ms: z.number().int(),
    challenge_id: z.string().optional(),
    tool: z
      .object({
        name: z.string().min(1),
        namespace: z.string().optional(),
        version: z.string().optional(),
      })
      .strict(),
    classifications: z.array(
      z
        .object({
          intent: z.string(),
          confidence: z.number().min(0).max(1),
          classifier: z.string(),
          alternatives: z.array(
            z
              .object({
                intent: z.string(),
                confidence: z.number().min(0).max(1),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

const sha256Schema = z.string().regex(SHA256_RE);
const verdictFieldSchema = z.string().max(8000);

export const verdictPayloadSchema = z
  .object({
    verdict: z.enum(["pass", "steer"]),
    confidence: z.number().min(0).max(1),
    message: z.string().nullable(),
    tool_call: verdictFieldSchema,
    goal: verdictFieldSchema,
    result: verdictFieldSchema,
    tool_call_sha256: sha256Schema,
    goal_sha256: sha256Schema,
    result_sha256: sha256Schema,
    latency_ms: z.number().int(),
  })
  .strict();

export const approvalGrantedPayloadSchema = z
  .object({
    request_id: z.string().min(1),
    key: z.string().min(1),
    title: z.string(),
    workspace_id: z.string().min(1),
    agent_id: z.string().min(1),
    status: z.literal("approved"),
    action: z.string(),
    resolved_by: z.string().optional(),
    resolved_at: z.string(),
    note: z.string().optional(),
    priority: z.enum(["low", "normal", "high", "critical"]),
  })
  .strict();

const vekinboxSourceSchema = z.enum(["metadata", "fixture"]).optional();

export const compensationExecutedPayloadSchema = z
  .object({
    request_id: z.string().min(1),
    execution_id: z.string().min(1),
    state_from: z.literal("compensation_required"),
    state_to: z.enum(["failed_verified", "invalidated", "executed"]),
    action: z.string(),
    note: z.string().optional(),
    source: vekinboxSourceSchema,
  })
  .strict();

export const receiptIssuedPayloadSchema = z
  .object({
    request_id: z.string().min(1),
    execution_id: z.string().min(1),
    tier: z.enum(["agent_asserted", "gateway_verified", "downstream_attested"]),
    action: z.string(),
    issued_at: z.string(),
    payload_sha256: sha256Schema,
    source: vekinboxSourceSchema,
  })
  .strict();

export const sessionRecordedPayloadSchema = z
  .object({
    visreplay_schema: z.literal("visreplay/session/1.0"),
    visreplay_session_id: z.string().min(1),
    session_name: z.string(),
    agent_type: z.string(),
    started_at: z.string(),
    ended_at: z.string().optional(),
    path: z.string().min(1),
    event_count: z.number().int(),
    event_counts: z
      .object({
        input: z.number().int(),
        reasoning: z.number().int(),
        tool_call: z.number().int(),
        tool_result: z.number().int(),
        output: z.number().int(),
        error: z.number().int(),
      })
      .strict(),
  })
  .strict();

const diffCaseStatusSchema = z.enum([
  "unchanged",
  "added",
  "removed",
  "changed",
  "improved",
]);

const whyCodeSchema = z.enum([
  "case_added",
  "case_removed",
  "error_raised",
  "error_resolved",
  "input_changed",
  "tool_call_reordered",
  "tool_call_removed",
  "tool_call_added",
  "tool_call_arguments_changed",
  "output_changed",
  "error_changed",
]);

export const diffComputedPayloadSchema = z
  .object({
    kind: z.literal("latticeag.viscompile.diff"),
    viscompile_schema_version: z.union([z.literal(1), z.literal(2)]),
    beliefs_omitted: z.boolean(),
    baseline_path: z.string().min(1),
    target_path: z.string().min(1),
    report_path: z.string().min(1),
    summary: z
      .object({
        unchanged: z.number().int(),
        added: z.number().int(),
        removed: z.number().int(),
        changed: z.number().int(),
        regressions: z.number().int(),
        improvements: z.number().int(),
      })
      .strict(),
    cases: z.array(
      z
        .object({
          id: z.string().min(1),
          status: diffCaseStatusSchema,
          regression: z.boolean(),
          why_codes: z.array(whyCodeSchema),
        })
        .strict(),
    ),
    lattice_exit: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  })
  .strict();

export const toolObservedPayloadSchema = z
  .object({
    source: z.enum(["axion", "visreplay"]),
    name: z.string().min(1),
    arguments: jsonObjectSchema,
    result: jsonValueSchema.optional(),
    error: z.string().optional(),
    argument_fingerprint: z.string().optional(),
    visreplay_event_id: z.string().optional(),
    axion_action_id: z.string().optional(),
  })
  .strict();

export const extensionPayloadSchema = z
  .object({
    extension_name: z.string().regex(EXTENSION_NAME_RE),
    payload: jsonValueSchema,
  })
  .strict();

export const busOverflowPayloadSchema = z
  .object({
    reason: z.enum(["capacity", "rotate", "sync_outbox"]),
    dropped_id: z.string().optional(),
    dropped_name: z.string().optional(),
    ring_size: z.number().int(),
    ring_capacity: z.number().int(),
  })
  .strict();

export const adapterErrorPayloadSchema = z
  .object({
    adapter: z.string().min(1),
    message: z.string(),
    cause_name: z.string().optional(),
    event_id: z.string().optional(),
  })
  .strict();

export const payloadSchemaByName = {
  belief_extracted: beliefExtractedPayloadSchema,
  policy_decision: policyDecisionPayloadSchema,
  verdict: verdictPayloadSchema,
  approval_granted: approvalGrantedPayloadSchema,
  compensation_executed: compensationExecutedPayloadSchema,
  receipt_issued: receiptIssuedPayloadSchema,
  session_recorded: sessionRecordedPayloadSchema,
  diff_computed: diffComputedPayloadSchema,
  tool_observed: toolObservedPayloadSchema,
  extension: extensionPayloadSchema,
  bus_overflow: busOverflowPayloadSchema,
  adapter_error: adapterErrorPayloadSchema,
} as const;

function envelopeOf<N extends EventName, S extends z.ZodType>(
  name: N,
  payload: S,
) {
  return z
    .object({
      ...envelopeFieldShape,
      name: z.literal(name),
      payload,
    })
    .strict();
}

export const latticeEventSchema = z.discriminatedUnion("name", [
  envelopeOf("belief_extracted", beliefExtractedPayloadSchema),
  envelopeOf("policy_decision", policyDecisionPayloadSchema),
  envelopeOf("verdict", verdictPayloadSchema),
  envelopeOf("approval_granted", approvalGrantedPayloadSchema),
  envelopeOf("compensation_executed", compensationExecutedPayloadSchema),
  envelopeOf("receipt_issued", receiptIssuedPayloadSchema),
  envelopeOf("session_recorded", sessionRecordedPayloadSchema),
  envelopeOf("diff_computed", diffComputedPayloadSchema),
  envelopeOf("tool_observed", toolObservedPayloadSchema),
  envelopeOf("extension", extensionPayloadSchema),
  envelopeOf("bus_overflow", busOverflowPayloadSchema),
  envelopeOf("adapter_error", adapterErrorPayloadSchema),
]);

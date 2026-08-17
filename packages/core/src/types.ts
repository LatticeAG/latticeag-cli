import type {
  AnyLatticeEvent,
  BeliefType,
  JsonObject,
  JsonValue,
} from "@latticeag/events";

export type { BeliefType, JsonObject, JsonValue };

export interface BusOptions {
  run_id: string;
  session_id: string;
  log_path: string;
  ring_capacity: number;
  overflow_block_ms: number;
  overflow: "block_then_drop" | "drop";
  persist_fail: "throw" | "log";
  redact_keys: string[];
  include_raw_text: boolean;
  max_log_bytes?: number;
}

export type BackendKind = "fixture" | "local" | "proxy" | "hosted";

export type StageId =
  | "inspect"
  | "shield"
  | "verify"
  | "record"
  | "approve"
  | "receipt"
  | "compensate"
  | "break_loop";

export interface StageBackendOverride {
  backend?: BackendKind;
  fixture?: string;
  timeout_ms?: number;
  force?: boolean;
}

export interface AutoChainOptions {
  verifyOnToolObserved?: boolean;
  approveOnSteer?: boolean;
  approveOnChallenge?: boolean;
  receiptOnApproved?: boolean;
}

export interface LatticeAGCreateOptions {
  cwd?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  run_id?: string;
  session_id?: string;
  ingest?: boolean;
  forceOwner?: boolean;
  auto?: AutoChainOptions;
  stages?: Partial<Record<StageId, StageBackendOverride>>;
  fixtures?: {
    beliefs?: string;
    approvals?: string;
    verdicts?: string;
    receipts?: string;
  };
  bus?: Pick<
    Partial<BusOptions>,
    | "log_path"
    | "ring_capacity"
    | "overflow_block_ms"
    | "overflow"
    | "max_log_bytes"
    | "persist_fail"
  >;
  abort?: AbortSignal;
  sync?: boolean;
}

export interface PipelineStep {
  stage: StageId;
  input: unknown;
}

export type InspectInput =
  | {
      source: "fixture";
      path?: string;
    }
  | {
      source: "session";
      session_id?: string;
    }
  | {
      source: "beliefs";
      beliefs: InspectBelief[];
      batch?: {
        spec: "axion.belief_batch.v1";
        calls_in_session: number;
        provider?: "openai" | "anthropic";
        model_name?: string;
        inbound_message_count?: number;
        redactions: number;
      };
    }
  | {
      source: "text";
      text: string;
      turns_ago?: number;
    };

export interface InspectBelief {
  id: string;
  type: BeliefType;
  text: string;
  evidence?: string;
  confidence: number;
  action_taken?: string;
  line: number;
  axion_timestamp_ms: number;
}

export interface ObserveToolInput {
  source: "axion" | "visreplay";
  name: string;
  arguments: JsonObject;
  result?: JsonValue;
  error?: string;
  argument_fingerprint?: string;
  visreplay_event_id?: string;
  axion_action_id?: string;
  causation_id?: string;
}

export interface VerifyInput {
  causation_id?: string;
  tool_call?: string;
  name?: string;
  arguments?: JsonObject;
  result?: JsonValue;
  error?: string;
  goal?: string;
  force?: boolean;
}

export interface RecordInput {
  path?: string;
  session_name?: string;
}

export interface ApproveInput {
  causation_id: string;
  source: "verdict" | "policy_decision" | "manual";
  title?: string;
  description?: string;
  timeout?: string;
  key?: string;
}

export interface ReceiptInput {
  request_id: string;
  execution_id?: string;
  action: string;
  payload_bytes: Uint8Array;
  issued_at?: string;
}

export interface ShieldInput {
  tool: string;
  arguments?: JsonObject;
  causation_id?: string;
}

export interface CompensateInput {
  request_id: string;
  execution_id: string;
  action: string;
  note?: string;
  state_to: "failed_verified" | "invalidated" | "executed";
}

export interface BreakLoopInput {
  window: Array<{ name: string; arguments?: JsonObject; result?: JsonValue }>;
  beliefs?: InspectBelief[];
}

export interface ResolvedBackend {
  stage: StageId;
  kind: BackendKind;
  detail: string;
  timeout_ms: number;
}

export interface DigestOptions {
  strict?: boolean;
  strictNames?: boolean;
}

export interface DigestItemError {
  index: number;
  pointer: string;
  message: string;
}

export interface DigestResult {
  schema: "latticeag.events/1.0";
  schema_version: 1;
  ok: boolean;
  events: AnyLatticeEvent[];
  unknown_names: string[];
  parse_errors: number;
  errors: DigestItemError[];
}

export interface HealthReport {
  ok: boolean;
  mode: "owner" | "child";
  run_id: string;
  session_id: string;
  bus: { seq: number; log_path: string };
  sync: { owner: "cli"; enabled: boolean };
  stages: Array<{
    id: StageId;
    enabled: boolean;
    backend?: ResolvedBackend;
    health?: { ok: boolean; detail: string };
  }>;
  secrets: Array<{
    id: string;
    presence: "present" | "absent" | "not_applicable";
    chars?: number;
  }>;
}

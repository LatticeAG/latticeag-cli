export { LatticeAG } from "./lattice.js";
export { digest } from "./digest.js";
export { createLangGraphCallback } from "./attach/langgraph.js";
export type { LangGraphCallback } from "./attach/langgraph.js";
export type { AgentAttachKit } from "./attach/types.js";
export type {
  LatticeAGCreateOptions,
  AutoChainOptions,
  StageBackendOverride,
  BackendKind,
  ResolvedBackend,
  HealthReport,
  DigestOptions,
  DigestResult,
  InspectInput,
  ShieldInput,
  VerifyInput,
  RecordInput,
  ObserveToolInput,
  ApproveInput,
  ReceiptInput,
  CompensateInput,
  BreakLoopInput,
  PipelineStep,
} from "./types.js";
export type { StageId, StageHandler, StageExecuteContext } from "./stages/types.js";
export {
  LatticeAGError,
  ConfigError,
  BackendUnresolvedError,
  StageDisabledError,
  StageNotImplementedError,
  StageTimeoutError,
  InspectTextUnsupportedError,
  ApprovalRejectedError,
  IngestBindError,
  PlatformError,
  ChildModeError,
  DigestError,
} from "./errors.js";
export type {
  AnyLatticeEvent,
  BeliefExtractedEvent,
  PolicyDecisionEvent,
  VerdictEvent,
  ApprovalGrantedEvent,
  CompensationExecutedEvent,
  ReceiptIssuedEvent,
  SessionRecordedEvent,
  ToolObservedEvent,
  ExtensionEvent,
  EventName,
} from "@latticeag/events";

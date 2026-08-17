import type { DigestResult, StageId } from "./types.js";

export interface ProbeLogEntry {
  kind: "fixture" | "local" | "proxy" | "hosted";
  ok: boolean;
  detail: string;
  duration_ms: number;
}

export class LatticeAGError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LatticeAGError";
    this.code = code;
  }
}

export class ConfigError extends LatticeAGError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = "ConfigError";
  }
}

export class BackendUnresolvedError extends LatticeAGError {
  readonly probes: ProbeLogEntry[];
  constructor(message: string, probes: ProbeLogEntry[], options?: { cause?: unknown }) {
    super("BACKEND_UNRESOLVED", message, options);
    this.name = "BackendUnresolvedError";
    this.probes = probes;
  }
}

export class StageDisabledError extends LatticeAGError {
  readonly stage: StageId;
  constructor(code: string, message: string, stage: StageId, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = "StageDisabledError";
    this.stage = stage;
  }
}

export class StageNotImplementedError extends LatticeAGError {
  readonly stage: StageId;
  constructor(code: string, message: string, stage: StageId, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = "StageNotImplementedError";
    this.stage = stage;
  }
}

export class StageTimeoutError extends LatticeAGError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = "StageTimeoutError";
  }
}

export class InspectTextUnsupportedError extends LatticeAGError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = "InspectTextUnsupportedError";
  }
}

export class ApprovalRejectedError extends LatticeAGError {
  readonly status: string;
  constructor(code: string, message: string, status: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = "ApprovalRejectedError";
    this.status = status;
  }
}

export class IngestBindError extends LatticeAGError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = "IngestBindError";
  }
}

export class PlatformError extends LatticeAGError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = "PlatformError";
  }
}

export class ChildModeError extends LatticeAGError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = "ChildModeError";
  }
}

export class DigestError extends LatticeAGError {
  readonly result: DigestResult;
  constructor(message: string, result: DigestResult, options?: { cause?: unknown }) {
    super("DIGEST_STRICT", message, options);
    this.name = "DigestError";
    this.result = result;
  }
}

import type {
  AnyLatticeEvent,
  ApprovalGrantedEvent,
  BeliefExtractedEvent,
  CompensationExecutedEvent,
  EventName,
  ExtensionEvent,
  PolicyDecisionEvent,
  ReceiptIssuedEvent,
  SessionRecordedEvent,
  ToolObservedEvent,
  VerdictEvent,
} from "@latticeag/events";
import type { LatticeagConfig } from "@latticeag/config";
import { digest } from "./digest.js";
import { createLattice } from "./create.js";
import type { CreateOptionsOverlay } from "./overlay.js";
import {
  ConfigError,
  LatticeAGError,
  StageDisabledError,
} from "./errors.js";
import { buildHealth } from "./health.js";
import { wrapAgent, type VisReplayStub } from "./integration/visreplay.js";
import { runPipeline } from "./pipeline.js";
import { resolveBackend, type ResolveBackendContext } from "./resolve-backend.js";
import { executeApprove, loadApprovalFixtures, type FixtureApproval } from "./stages/approve.js";
import { executeBreakLoop } from "./stages/break-loop.js";
import { executeCompensate } from "./stages/compensate.js";
import { executeInspect } from "./stages/inspect.js";
import { executeObserveTool } from "./stages/observe-tool.js";
import { executeReceipt } from "./stages/receipt.js";
import { executeRecord } from "./stages/record.js";
import { StageRegistry } from "./stages/registry.js";
import { executeShield } from "./stages/shield.js";
import type { BusLike, StageExecuteContext, StageHandler } from "./stages/types.js";
import { executeVerify, loadVerdictFixtures } from "./stages/verify.js";
import type { Subscriber } from "./owner-bus.js";
import type {
  ApproveInput,
  BreakLoopInput,
  CompensateInput,
  DigestOptions,
  DigestResult,
  HealthReport,
  InspectInput,
  LatticeAGCreateOptions,
  ObserveToolInput,
  PipelineStep,
  ReceiptInput,
  RecordInput,
  ResolvedBackend,
  ShieldInput,
  StageId,
  VerifyInput,
} from "./types.js";

export type { BusLike, Subscriber };

export class LatticeAG {
  static async create(opts?: LatticeAGCreateOptions): Promise<LatticeAG> {
    const created = await createLattice(opts);
    return new LatticeAG(created);
  }

  static digest(input: unknown, opts?: DigestOptions): DigestResult {
    return digest(input, opts);
  }

  readonly run_id: string;
  readonly session_id: string;
  readonly config: LatticeagConfig;
  readonly mode: "owner" | "child";
  readonly bus: BusLike;

  #closed = false;
  #cwd: string;
  #env: NodeJS.ProcessEnv;
  #overlay: CreateOptionsOverlay;
  #abort: AbortSignal;
  #ingestStop?: () => Promise<void>;
  #adapterStops: Array<() => Promise<void>>;
  #logPath: string;
  #registry = new StageRegistry();
  #cache = new Map<StageId, ResolvedBackend>();
  #seenBeliefIds = new Set<string>();
  #seenTools = new Map<string, ToolObservedEvent>();
  #verdicts = new Map<string, VerdictEvent>();
  #eventsById = new Map<string, AnyLatticeEvent>();
  #verdictFixtures: { rows: Awaited<ReturnType<typeof loadVerdictFixtures>> } = { rows: [] };
  #approvalFixtures: FixtureApproval[] = [];
  #fixturesLoaded = false;
  #visReplay: VisReplayStub | undefined;
  #recorded = false;

  private constructor(created: Awaited<ReturnType<typeof createLattice>>) {
    this.run_id = created.run_id;
    this.session_id = created.session_id;
    this.config = created.config;
    this.mode = created.mode;
    this.bus = created.bus;
    this.#cwd = created.cwd;
    this.#env = created.env;
    this.#overlay = created.overlay;
    this.#abort = created.abort;
    this.#ingestStop = created.ingest ? () => created.ingest!.stop() : undefined;
    this.#adapterStops = created.adapterStops;
    this.#logPath = created.log_path;
    this.bus.subscribe("*", (event) => {
      this.#eventsById.set(event.id, event);
    });
  }

  async inspect(input: InspectInput): Promise<BeliefExtractedEvent[]> {
    this.#assertOpen();
    return this.#guard("inspect", "@latticeag/adapter-axion", async () => {
      const ctx = await this.#ctx("inspect");
      return executeInspect(input, ctx, this.#seenBeliefIds);
    });
  }

  async shield(input: ShieldInput): Promise<PolicyDecisionEvent> {
    this.#assertOpen();
    const custom = this.#registry.get("shield");
    if (custom) {
      return this.#runHandler(custom, input) as Promise<PolicyDecisionEvent>;
    }
    if (!this.config.adapters.lexshield.enabled) {
      throw new StageDisabledError("STAGE_DISABLED", "product: lexshield", "shield");
    }
    return this.#guard("shield", "@latticeag/adapter-lexshield", () =>
      executeShield(input, this.#ctxSync("shield")),
    );
  }

  async verify(input: VerifyInput): Promise<VerdictEvent> {
    this.#assertOpen();
    return this.#guard("verify", "@latticeag/adapter-lexverdict", async () => {
      await this.#ensureFixtures();
      const ctx = await this.#ctx("verify");
      const event = await executeVerify(input, ctx, this.#verdicts, this.#verdictFixtures);
      if (
        this.#overlay.auto.approveOnSteer &&
        event.payload.verdict === "steer"
      ) {
        await this.approve({ causation_id: event.id, source: "verdict" });
      }
      return event;
    });
  }

  async record(input?: RecordInput): Promise<SessionRecordedEvent> {
    this.#assertOpen();
    return this.#guard("record", "@latticeag/adapter-visreplay", async () => {
      const ctx = await this.#ctx("record");
      const event = await executeRecord(input ?? {}, ctx, this.#visReplay);
      this.#recorded = true;
      return event;
    });
  }

  async observeTool(input: ObserveToolInput): Promise<ToolObservedEvent> {
    this.#assertOpen();
    return this.#guard("inspect", "@latticeag/adapter-visreplay", async () => {
      const ctx = this.#emitCtx();
      const event = await executeObserveTool(input, ctx, this.#seenTools);
      if (this.#overlay.auto.verifyOnToolObserved) {
        await this.verify({
          causation_id: event.id,
          name: event.payload.name,
          arguments: event.payload.arguments,
          result: event.payload.result,
          error: event.payload.error,
        });
      }
      return event;
    });
  }

  async approve(input: ApproveInput): Promise<ApprovalGrantedEvent> {
    this.#assertOpen();
    return this.#guard("approve", "@latticeag/adapter-vekinbox", async () => {
      await this.#ensureFixtures();
      const ctx = await this.#ctx("approve");
      const event = await executeApprove(input, ctx, this.#eventsById, this.#approvalFixtures);
      if (this.#overlay.auto.receiptOnApproved) {
        await this.receipt({
          request_id: event.payload.request_id,
          action: event.payload.action,
          payload_bytes: new TextEncoder().encode(JSON.stringify(event.payload)),
        });
      }
      return event;
    });
  }

  async receipt(input: ReceiptInput): Promise<ReceiptIssuedEvent> {
    this.#assertOpen();
    const custom = this.#registry.get("receipt");
    if (custom && this.#env.LATTICEAG_RECEIPT_PROVIDER === "visreceipt") {
      return this.#runHandler(custom, input) as Promise<ReceiptIssuedEvent>;
    }
    return this.#guard("receipt", "@latticeag/adapter-vekinbox", async () => {
      const ctx = await this.#ctx("receipt");
      return executeReceipt(input, ctx);
    });
  }

  async compensate(input: CompensateInput): Promise<CompensationExecutedEvent> {
    this.#assertOpen();
    const custom = this.#registry.get("compensate");
    if (custom) {
      return this.#runHandler(custom, input) as Promise<CompensationExecutedEvent>;
    }
    return executeCompensate(input, this.#ctxSync("compensate"));
  }

  async breakLoop(input: BreakLoopInput): Promise<ExtensionEvent> {
    this.#assertOpen();
    const custom = this.#registry.get("break_loop");
    if (custom) {
      return this.#runHandler(custom, input) as Promise<ExtensionEvent>;
    }
    return executeBreakLoop(input, this.#ctxSync("break_loop"));
  }

  wrap<T extends object>(agent: T): T {
    this.#assertOpen();
    if (this.#visReplay) {
      throw new ConfigError("ALREADY_WRAPPED", "wrap() already called");
    }
    const wrapped = wrapAgent(agent, {
      sessionName: this.run_id,
      agentType: this.config.adapters.visreplay.agent_type,
      sessionId: this.session_id,
    });
    this.#visReplay = wrapped.visReplay;
    return wrapped.agent;
  }

  on(name: EventName | "*", fn: Subscriber): () => void {
    return this.bus.subscribe(name, fn);
  }

  registerStage(handler: StageHandler<unknown, AnyLatticeEvent | AnyLatticeEvent[]>): void {
    this.#registry.register(handler, this.#env);
  }

  pipeline(steps: PipelineStep[]): Promise<AnyLatticeEvent[]> {
    this.#assertOpen();
    return runPipeline(this, steps);
  }

  async health(): Promise<HealthReport> {
    return buildHealth({
      mode: this.mode,
      run_id: this.run_id,
      session_id: this.session_id,
      bus: this.bus,
      log_path: this.#logPath,
      config: this.config,
      env: this.#env,
      resolveCtx: this.#resolveCtx(),
    });
  }

  async resolve(stage?: StageId): Promise<Record<StageId, ResolvedBackend> | ResolvedBackend> {
    if (stage) {
      return resolveBackend(stage, this.#resolveCtx());
    }
    const ids: StageId[] = [
      "inspect",
      "shield",
      "verify",
      "record",
      "approve",
      "receipt",
      "compensate",
      "break_loop",
    ];
    const out = {} as Record<StageId, ResolvedBackend>;
    for (const id of ids) {
      try {
        out[id] = await resolveBackend(id, this.#resolveCtx());
      } catch {
        // omit unresolved
      }
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (this.#visReplay && !this.#recorded) {
      try {
        await this.record();
      } catch {
        // drain best-effort
      }
    }
    this.#closed = true;
    for (const stop of this.#adapterStops) {
      await stop();
    }
    if (this.#ingestStop) {
      await this.#ingestStop();
    }
    await this.bus.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new LatticeAGError("CLOSED", "LatticeAG is closed");
    }
  }

  #resolveCtx(): ResolveBackendContext {
    return {
      cwd: this.#cwd,
      env: this.#env,
      config: this.config,
      overlay: this.#overlay,
      registered: this.#registry.ids(),
      fetchImpl: fetch,
      cache: this.#cache,
    };
  }

  async #ctx(stage: StageId): Promise<StageExecuteContext> {
    const backend = await resolveBackend(stage, this.#resolveCtx());
    return {
      config: this.config,
      bus: this.bus,
      cwd: this.#cwd,
      env: this.#env,
      abort: this.#abort,
      run_id: this.run_id,
      session_id: this.session_id,
      backend,
    };
  }

  #emitCtx(): StageExecuteContext {
    return {
      config: this.config,
      bus: this.bus,
      cwd: this.#cwd,
      env: this.#env,
      abort: this.#abort,
      run_id: this.run_id,
      session_id: this.session_id,
      backend: {
        stage: "inspect",
        kind: "fixture",
        detail: "observeTool",
        timeout_ms: 15000,
      },
    };
  }

  #ctxSync(stage: StageId): StageExecuteContext {
    const backend = this.#cache.get(stage) ?? {
      stage,
      kind: "fixture" as const,
      detail: "unresolved",
      timeout_ms: 15000,
    };
    return {
      config: this.config,
      bus: this.bus,
      cwd: this.#cwd,
      env: this.#env,
      abort: this.#abort,
      run_id: this.run_id,
      session_id: this.session_id,
      backend,
    };
  }

  async #ensureFixtures(): Promise<void> {
    if (this.#fixturesLoaded) {
      return;
    }
    this.#fixturesLoaded = true;
    const verdicts = this.#overlay.fixtures.verdicts;
    if (verdicts) {
      this.#verdictFixtures.rows = await loadVerdictFixtures(verdicts);
    }
    const approvals = this.#overlay.fixtures.approvals;
    if (approvals) {
      this.#approvalFixtures = await loadApprovalFixtures(approvals);
    }
  }

  async #guard<T>(
    stage: StageId,
    adapter: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (
        err instanceof LatticeAGError &&
        (err.code === "CLOSED" ||
          err.code === "VERIFY_FIELD_TOO_LONG" ||
          err.code === "APPROVAL_REJECTED" ||
          err.code === "STAGE_DISABLED" ||
          err.code === "STAGE_NOT_IMPLEMENTED" ||
          err.code === "INSPECT_TEXT_UNSUPPORTED" ||
          err.code === "NO_SESSION" ||
          err.code === "STAGE_LOCKED" ||
          err.code === "CONFIG_NOT_FOUND" ||
          err.code === "CONFIG_INVALID")
      ) {
        throw err;
      }
      try {
        await this.bus.emit({
          name: "adapter_error",
          payload: {
            adapter,
            message: err instanceof Error ? err.message : String(err),
            cause_name: err instanceof Error ? err.name : undefined,
          },
          producer: {
            product: "latticeag",
            adapter: "latticeag-internal",
            adapter_version: "0.1.0",
          },
          correlation_id: this.run_id,
        });
      } catch {
        // still throw original
      }
      throw err;
    }
  }

  async #runHandler(
    handler: StageHandler<unknown, AnyLatticeEvent | AnyLatticeEvent[]>,
    input: unknown,
  ): Promise<AnyLatticeEvent | AnyLatticeEvent[]> {
    const parsed = handler.inputSchema.parse(input);
    const ctx = await this.#ctx(handler.id);
    const result = await handler.execute(parsed, ctx);
    const events = Array.isArray(result) ? result : [result];
    for (const event of events) {
      if (!this.#eventsById.has(event.id)) {
        await this.bus.emit({
          name: event.name as EventName,
          payload: event.payload as never,
          producer: event.producer,
          correlation_id: event.correlation_id,
          causation_id: event.causation_id,
        });
      }
    }
    return result;
  }
}

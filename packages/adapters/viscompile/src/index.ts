import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  Adapter,
  AdapterContext,
  AdapterHealth,
  LatticeBus,
} from "@latticeag/bus";
import type {
  AnyLatticeEvent,
  DiffCaseStatus,
  DiffComputedPayload,
  JsonValue,
  Producer,
  WhyCode,
} from "@latticeag/events";
import { supportsBeliefs } from "./detect.js";
import {
  projectTranscript,
  type SchemaVersion,
  type TranscriptDocument,
} from "./project.js";

export { supportsBeliefs, capCachePath } from "./detect.js";
export { projectTranscript } from "./project.js";
export type {
  TranscriptDocument,
  TranscriptCase,
  TranscriptCaseEvent,
  SchemaVersion,
} from "./project.js";

const execFileAsync = promisify(execFile);

export const ADAPTER_VERSION = "0.1.0";
export const ADAPTER_ID = "viscompile";
export const LATTICE_NOT_FOUND = "lattice binary not found";

const PRODUCER: Producer = {
  product: "viscompile",
  adapter: "@latticeag/adapter-viscompile",
  adapter_version: ADAPTER_VERSION,
};

const WHY_CODES = new Set<WhyCode>([
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

const CASE_STATUSES = new Set<DiffCaseStatus>([
  "unchanged",
  "added",
  "removed",
  "changed",
  "improved",
]);

interface SpawnResult {
  status: number;
  stdout: string;
  stderr: string;
  notFound: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findLatticeBin(
  binName: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (path.isAbsolute(binName) && existsSync(binName)) {
    return binName;
  }
  const pathEnv = env.PATH ?? process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, binName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function spawnLattice(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  try {
    const result = await execFileAsync(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      status: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      notFound: false,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: 127, stdout: "", stderr: "", notFound: true };
    }
    const status =
      typeof (err as { status?: unknown }).status === "number"
        ? ((err as { status: number }).status)
        : typeof code === "number"
          ? code
          : 1;
    const stdout =
      typeof (err as { stdout?: unknown }).stdout === "string"
        ? (err as { stdout: string }).stdout
        : "";
    const stderr =
      typeof (err as { stderr?: unknown }).stderr === "string"
        ? (err as { stderr: string }).stderr
        : err instanceof Error
          ? err.message
          : String(err);
    return { status, stdout, stderr, notFound: false };
  }
}

async function emitAdapterError(
  bus: LatticeBus,
  message: string,
  causeName?: string,
): Promise<void> {
  await bus.emit({
    name: "adapter_error",
    producer: PRODUCER,
    correlation_id: bus.run_id,
    payload: {
      adapter: "@latticeag/adapter-viscompile",
      message,
      ...(causeName !== undefined ? { cause_name: causeName } : {}),
    },
  });
}

function asInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function mapWhyCodes(raw: unknown): WhyCode[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: WhyCode[] = [];
  for (const item of raw) {
    if (typeof item === "string" && WHY_CODES.has(item as WhyCode)) {
      out.push(item as WhyCode);
    }
  }
  return out;
}

function mapStatus(raw: unknown): DiffCaseStatus {
  if (typeof raw === "string" && CASE_STATUSES.has(raw as DiffCaseStatus)) {
    return raw as DiffCaseStatus;
  }
  return "changed";
}

function latticeExit(status: number): DiffComputedPayload["lattice_exit"] {
  if (status === 2) {
    return 2;
  }
  if (status === 0) {
    return 0;
  }
  return 1;
}

function parseLatticeDiff(
  raw: unknown,
  extras: {
    schemaVersion: SchemaVersion;
    beliefsOmitted: boolean;
    baselinePath: string;
    targetPath: string;
    reportPath: string;
    latticeExit: DiffComputedPayload["lattice_exit"];
  },
): DiffComputedPayload | undefined {
  if (!isRecord(raw) || !isRecord(raw.summary) || !Array.isArray(raw.cases)) {
    return undefined;
  }
  if (raw.kind !== "latticeag.viscompile.diff") {
    return undefined;
  }
  const cases: DiffComputedPayload["cases"] = [];
  for (const item of raw.cases) {
    if (!isRecord(item) || typeof item.id !== "string") {
      continue;
    }
    cases.push({
      id: item.id,
      status: mapStatus(item.status),
      regression: item.regression === true,
      why_codes: mapWhyCodes(item.why_codes),
    });
  }
  return {
    kind: "latticeag.viscompile.diff",
    viscompile_schema_version: extras.schemaVersion,
    beliefs_omitted: extras.beliefsOmitted,
    baseline_path: extras.baselinePath,
    target_path: extras.targetPath,
    report_path: extras.reportPath,
    summary: {
      unchanged: asInt(raw.summary.unchanged),
      added: asInt(raw.summary.added),
      removed: asInt(raw.summary.removed),
      changed: asInt(raw.summary.changed),
      regressions: asInt(raw.summary.regressions),
      improvements: asInt(raw.summary.improvements),
    },
    cases,
    lattice_exit: extras.latticeExit,
  };
}

function caseInput(env: NodeJS.ProcessEnv): JsonValue {
  const goal = env.LATTICEAG_GOAL;
  if (typeof goal === "string" && goal.length > 0) {
    return { prompt: goal };
  }
  return { prompt: "complete the user task" };
}

export function createAdapter(): Adapter {
  let ctx: AdapterContext | undefined;
  const unsubs: Array<() => void> = [];
  const collected: AnyLatticeEvent[] = [];
  let projecting: Promise<void> | undefined;
  let lastHealth: AdapterHealth = {
    id: ADAPTER_ID,
    ok: false,
    detail: "not started",
  };

  async function runProjection(): Promise<void> {
    if (!ctx) {
      return;
    }
    if (projecting) {
      await projecting;
      return;
    }
    projecting = doProjection().catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (ctx) {
        const notFound =
          message.includes("ENOENT") || message.includes(LATTICE_NOT_FOUND);
        await emitAdapterError(
          ctx.bus,
          notFound ? LATTICE_NOT_FOUND : message,
          notFound ? "SpawnError" : err instanceof Error ? err.name : undefined,
        );
      }
    });
    try {
      await projecting;
    } finally {
      // keep projecting set so a later session_recorded/stop does not double-diff
    }
  }

  async function doProjection(): Promise<void> {
    if (!ctx) {
      return;
    }
    const { bus, cwd, env, config } = ctx;
    const vis = config.adapters.viscompile;
    const latticeDir = path.join(cwd, ".latticeag");
    mkdirSync(latticeDir, { recursive: true });

    const baselinePath = path.resolve(cwd, vis.baseline);
    if (!existsSync(baselinePath)) {
      await emitAdapterError(bus, `baseline not found: ${vis.baseline}`);
      return;
    }

    const logPath = path.resolve(cwd, config.bus.log_path);
    const events: AnyLatticeEvent[] = [];
    try {
      for await (const event of bus.replay(logPath, 1)) {
        if (event.run_id === bus.run_id) {
          events.push(event);
        }
      }
    } catch {
      events.push(...collected);
    }
    if (events.length === 0) {
      events.push(...collected.filter((event) => event.run_id === bus.run_id));
    }

    const input = caseInput(env);
    const caseId = config.project.name;
    const v1 = projectTranscript(events, caseId, input, 1);
    const v2 = projectTranscript(events, caseId, input, 2);
    const v1Path = path.join(latticeDir, "transcript.v1.json");
    const v2Path = path.join(latticeDir, "transcript.v2.json");
    writeFileSync(v1Path, `${JSON.stringify(v1, null, 2)}\n`);
    writeFileSync(v2Path, `${JSON.stringify(v2, null, 2)}\n`);

    const bin = findLatticeBin(vis.bin, env);
    if (!bin) {
      await emitAdapterError(bus, LATTICE_NOT_FOUND, "SpawnError");
      return;
    }

    const configuredVersion: SchemaVersion = vis.schema_version === 1 ? 1 : 2;
    let v2ok = false;
    try {
      v2ok = await supportsBeliefs(bin);
    } catch {
      v2ok = false;
    }

    const useV2 = configuredVersion === 2 && v2ok;
    const targetDoc: TranscriptDocument = useV2 ? v2 : v1;
    const beliefsOmitted = !useV2;
    const targetPath = path.join(latticeDir, "target.json");
    const reportPath = path.join(latticeDir, "diff-report.json");
    writeFileSync(targetPath, `${JSON.stringify(targetDoc, null, 2)}\n`);

    const args = [
      "diff",
      "--baseline",
      baselinePath,
      "--target",
      targetPath,
      "--format",
      "json",
      "--out",
      reportPath,
    ];
    if (vis.fail_on_regression) {
      args.push("--fail-on-regression");
    }

    const spawned = await spawnLattice(bin, args, cwd, env);
    if (spawned.notFound) {
      await emitAdapterError(bus, LATTICE_NOT_FOUND, "SpawnError");
      return;
    }

    let parsedJson: unknown;
    try {
      if (existsSync(reportPath)) {
        parsedJson = JSON.parse(readFileSync(reportPath, "utf8")) as unknown;
      } else if (spawned.stdout.trim().length > 0) {
        parsedJson = JSON.parse(spawned.stdout) as unknown;
      }
    } catch (err) {
      await emitAdapterError(
        bus,
        `failed to parse lattice diff: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const payload = parseLatticeDiff(parsedJson, {
      schemaVersion: useV2 ? 2 : 1,
      beliefsOmitted,
      baselinePath,
      targetPath,
      reportPath,
      latticeExit: latticeExit(spawned.status),
    });
    if (!payload) {
      await emitAdapterError(
        bus,
        spawned.stderr.trim() ||
          `lattice diff failed (exit ${spawned.status})`,
      );
      return;
    }

    await bus.emit({
      name: "diff_computed",
      producer: PRODUCER,
      correlation_id: bus.run_id,
      payload,
    });
  }

  return {
    id: ADAPTER_ID,
    product: "viscompile",
    async start(startCtx: AdapterContext): Promise<void> {
      ctx = startCtx;
      collected.length = 0;
      projecting = undefined;
      unsubs.push(
        startCtx.bus.subscribe("*", (event) => {
          collected.push(event);
        }),
      );
      unsubs.push(
        startCtx.bus.subscribe("session_recorded", () => {
          void runProjection();
        }),
      );
      const bin = findLatticeBin(
        startCtx.config.adapters.viscompile.bin,
        startCtx.env,
      );
      lastHealth = {
        id: ADAPTER_ID,
        ok: true,
        detail: bin ?? "lattice not on PATH",
      };
    },
    async health(): Promise<AdapterHealth> {
      if (!ctx) {
        return lastHealth;
      }
      const bin = findLatticeBin(ctx.config.adapters.viscompile.bin, ctx.env);
      lastHealth = {
        id: ADAPTER_ID,
        ok: Boolean(bin),
        detail: bin ?? LATTICE_NOT_FOUND,
      };
      return lastHealth;
    },
    async stop(): Promise<void> {
      await runProjection();
      for (const u of unsubs.splice(0)) {
        u();
      }
      ctx = undefined;
    },
    redactKeys(): string[] {
      return [];
    },
  };
}

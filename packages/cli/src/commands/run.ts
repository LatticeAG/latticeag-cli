import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { Option } from "commander";
import { parse as parseDotenv } from "dotenv";
import { execa } from "execa";
import stringArgv from "string-argv";
import {
  BusPersistError,
  LatticeBus,
  isUlid,
  newRunId,
  newSessionId,
  type Adapter,
} from "@latticeag/bus";
import {
  loadConfig,
  type LoadedConfig,
} from "@latticeag/config";
import { getAttachKit, isAttachKitId, type AttachKitId } from "../attach/index.js";
import { addGlobalOptions, readGlobalOpts } from "../globals.js";
import { startIngest, type IngestServer } from "../ingest.js";
import { fail, writeJson } from "../json-envelope.js";
import { failConfig } from "../config-fail.js";
import {
  AdapterOverlayError,
  createAdapters,
  resolveRunAdapters,
  startAdapters,
  stopAdapters,
} from "../start-adapters.js";

export const WINDOWS_UNSUPPORTED =
  "latticeag run does not support windows in v0.1";

export const SYNC_OUTBOX_REL = path.join(".latticeag", "sync-outbox.jsonl");

export interface RunResult {
  run_id: string;
  session_id: string;
  child_exit: number;
  event_count: number;
  log_path: string;
  adapters_started: string[];
  duration_ms: number;
}

export interface RunFlags {
  cmd: string;
  attach: AttachKitId;
  adapters?: string;
  envFile?: string;
  timeoutMs: number;
  runId?: string;
  sessionId?: string;
  fixtureBeliefs?: string;
  fixtureApprovals?: string;
  failOnSync: boolean;
  json: boolean;
  verbose: boolean;
  quiet: boolean;
  captureChild: boolean;
}

export function isUnsupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32";
}

export function busPidPath(cwd: string): string {
  return path.join(cwd, ".latticeag", "bus.pid");
}

export function writeBusPid(cwd: string): string {
  const dir = path.join(cwd, ".latticeag");
  mkdirSync(dir, { recursive: true });
  const file = busPidPath(cwd);
  writeFileSync(file, `${process.pid}\n`);
  return file;
}

export function removeBusPid(cwd: string): void {
  const file = busPidPath(cwd);
  if (!existsSync(file)) {
    return;
  }
  try {
    const raw = readFileSync(file, "utf8").trim();
    if (raw === String(process.pid)) {
      unlinkSync(file);
    }
  } catch {
    // pid file already gone
  }
}

function logVerbose(flags: RunFlags, message: string): void {
  if (flags.verbose && !flags.quiet) {
    process.stderr.write(`${message}\n`);
  }
}

export function loadEnvFile(
  cwd: string,
  envFileFlag: string | undefined,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const defaultPath = path.join(cwd, ".env");
  let file: string | undefined;
  if (envFileFlag !== undefined) {
    file = path.resolve(cwd, envFileFlag);
    if (!existsSync(file)) {
      throw new Error(`env file not found: ${envFileFlag}`);
    }
  } else if (existsSync(defaultPath)) {
    file = defaultPath;
  }
  if (!file) {
    return env;
  }
  const parsed = parseDotenv(readFileSync(file));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export function syncOutboxNonEmpty(cwd: string): boolean {
  const file = path.join(cwd, SYNC_OUTBOX_REL);
  if (!existsSync(file)) {
    return false;
  }
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

function resolveLogPath(loaded: LoadedConfig): string {
  return path.resolve(path.dirname(loaded.path), loaded.config.bus.log_path);
}

export function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  if (Array.isArray(value)) {
    return value.map(asText).join("");
  }
  if (value == null) {
    return "";
  }
  return String(value);
}

function parseNonNegInt(raw: unknown, fallback: number, flag: string): number {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid ${flag}`);
  }
  return Math.floor(n);
}

export interface LatticeRunContext {
  cwd: string;
  loaded: LoadedConfig;
  bus: LatticeBus;
  ingest: IngestServer;
  adapters: Adapter[];
  adapters_started: string[];
  child: ReturnType<typeof execa>;
  run_id: string;
  session_id: string;
  log_path: string;
  log_path_display: string;
  started_at: number;
  abort: AbortController;
}

async function shutdownRun(
  ctx: Pick<
    LatticeRunContext,
    "cwd" | "adapters" | "ingest" | "bus"
  >,
): Promise<void> {
  await stopAdapters(ctx.adapters);
  await ctx.ingest.close().catch(() => undefined);
  await ctx.bus.close().catch(() => undefined);
  removeBusPid(ctx.cwd);
}

export async function startLatticeRun(
  flags: RunFlags,
): Promise<LatticeRunContext> {
  if (isUnsupportedPlatform()) {
    fail(WINDOWS_UNSUPPORTED, {
      json: flags.json,
      command: "run",
      code: "USAGE",
      exitCode: 1,
    });
  }
  if (!flags.cmd || flags.cmd.trim().length === 0) {
    fail("--cmd is required", {
      json: flags.json,
      command: "run",
      code: "USAGE",
    });
  }

  const cwd = process.cwd();
  let loaded: LoadedConfig;
  try {
    loaded = loadConfig(cwd);
  } catch (err) {
    failConfig(err, flags.json, "run");
  }

  let env: NodeJS.ProcessEnv;
  try {
    env = loadEnvFile(cwd, flags.envFile, process.env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), {
      json: flags.json,
      command: "run",
      code: "USAGE",
    });
  }

  let adapterNames;
  try {
    adapterNames = resolveRunAdapters(loaded.config, flags.adapters);
  } catch (err) {
    if (err instanceof AdapterOverlayError) {
      fail(err.message, {
        json: flags.json,
        command: "run",
        code: "USAGE",
      });
    }
    throw err;
  }

  const run_id = flags.runId ?? newRunId();
  if (flags.runId && !isUlid(flags.runId)) {
    fail(`--run-id must be a ULID: ${flags.runId}`, {
      json: flags.json,
      command: "run",
      code: "USAGE",
    });
  }
  const session_id = flags.sessionId ?? newSessionId();
  const log_path = resolveLogPath(loaded);
  const log_path_display = loaded.config.bus.log_path;

  mkdirSync(path.dirname(log_path), { recursive: true });

  const bus = new LatticeBus({
    run_id,
    session_id,
    log_path,
    ring_capacity: loaded.config.bus.ring_capacity,
    overflow_block_ms: loaded.config.bus.overflow_block_ms,
    overflow: loaded.config.bus.overflow,
    persist_fail: loaded.config.bus.persist_fail,
    redact_keys: [...loaded.config.redaction.keys],
    include_raw_text: loaded.config.redaction.include_raw_text,
    max_log_bytes: loaded.config.bus.max_log_bytes,
  });
  writeBusPid(cwd);

  if (flags.fixtureBeliefs) {
    env.LATTICEAG_FIXTURE_BELIEFS = path.resolve(cwd, flags.fixtureBeliefs);
  }
  if (flags.fixtureApprovals) {
    env.LATTICEAG_FIXTURE_APPROVALS = path.resolve(cwd, flags.fixtureApprovals);
  }
  env.LATTICEAG_RUN_ID = run_id;
  env.LATTICEAG_SESSION_ID = session_id;
  env.LATTICEAG_EVENTS_PATH = log_path;
  env.LATTICEAG_CONFIG = loaded.path;

  const abort = new AbortController();
  let ingest: IngestServer | undefined;
  const adapters = await createAdapters(adapterNames);
  let started: Adapter[] = [];

  try {
    logVerbose(
      flags,
      `starting ingest ${loaded.config.ingest.bind}:${loaded.config.ingest.port}`,
    );
    ingest = await startIngest({
      config: loaded.config,
      bus,
      cwd,
      env,
    });
    env.LATTICEAG_INGEST_URL = ingest.url;

    const kit = getAttachKit(flags.attach);
    const axionEnabled = adapterNames.includes("axion");
    const injected = kit.injectEnv(env, {
      config: loaded.config,
      run_id,
      session_id,
      ingest_url: ingest.url,
      ...(axionEnabled
        ? { axion_base_url: loaded.config.adapters.axion.base_url }
        : {}),
    });
    Object.assign(env, injected);
    for (const [key, value] of Object.entries(env)) {
      if (process.env[key] === undefined && value !== undefined) {
        process.env[key] = value;
      }
    }
    if (kit.beforeSpawn) {
      await kit.beforeSpawn(cwd);
    }

    const ctx = {
      config: loaded.config,
      bus,
      cwd,
      env,
      abort: abort.signal,
      registerIngest: ingest.registerIngest,
    };
    logVerbose(
      flags,
      `starting adapters: ${adapterNames.join(", ") || "(none)"}`,
    );
    started = await startAdapters(adapters, ctx);

    const argv = stringArgv(flags.cmd);
    const file = argv[0];
    if (!file) {
      fail("--cmd is required", {
        json: flags.json,
        command: "run",
        code: "USAGE",
      });
    }
    const args = argv.slice(1);
    logVerbose(flags, `spawn ${flags.cmd}`);

    const capture = flags.captureChild;
    const child = execa(file, args, {
      preferLocal: true,
      shell: false,
      cwd,
      env,
      stdin: "inherit",
      stdout: capture ? "pipe" : "inherit",
      stderr: capture ? "pipe" : "inherit",
      killSignal: "SIGTERM",
      forceKillAfterTimeout: 5000,
      reject: false,
      cancelSignal: abort.signal,
      ...(flags.timeoutMs > 0 ? { timeout: flags.timeoutMs } : {}),
    });

    return {
      cwd,
      loaded,
      bus,
      ingest,
      adapters: started,
      adapters_started: started.map((a) => a.id),
      child,
      run_id,
      session_id,
      log_path,
      log_path_display,
      started_at: Date.now(),
      abort,
    };
  } catch (err) {
    await stopAdapters(started).catch(() => undefined);
    await ingest?.close().catch(() => undefined);
    await bus.close().catch(() => undefined);
    removeBusPid(cwd);
    if (err instanceof BusPersistError) {
      fail(err.message, {
        json: flags.json,
        command: "run",
        code: "BUS_PERSIST",
        exitCode: 4,
      });
    }
    fail(err instanceof Error ? err.message : String(err), {
      json: flags.json,
      command: "run",
      code: "ADAPTER",
      exitCode: 4,
    });
  }
}

export async function finishLatticeRun(
  ctx: LatticeRunContext,
  flags: RunFlags,
  childExit: number,
  captured?: { stdout: string; stderr: string },
): Promise<RunResult> {
  if (captured && flags.captureChild) {
    const dir = path.join(ctx.cwd, ".latticeag");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "child-stdout.log"), captured.stdout);
    writeFileSync(path.join(dir, "child-stderr.log"), captured.stderr);
  }

  await shutdownRun(ctx);

  const result: RunResult = {
    run_id: ctx.run_id,
    session_id: ctx.session_id,
    child_exit: childExit,
    event_count: ctx.bus.seq(),
    log_path: ctx.log_path_display,
    adapters_started: ctx.adapters_started,
    duration_ms: Date.now() - ctx.started_at,
  };

  if (flags.failOnSync && syncOutboxNonEmpty(ctx.cwd)) {
    printRunResult(result, flags, false);
    process.exit(5);
  }

  return result;
}

export function printRunResult(
  result: RunResult,
  flags: Pick<RunFlags, "json">,
  ok: boolean,
): void {
  if (flags.json) {
    writeJson(
      "run",
      ok,
      result,
      ok
        ? undefined
        : {
            code: "CHILD_EXIT",
            message: `child_exit ${result.child_exit}`,
          },
    );
    return;
  }
  const lines = [
    `run_id ${result.run_id}`,
    `session_id ${result.session_id}`,
    `child_exit ${result.child_exit}`,
    `events ${result.event_count}`,
    `log ${result.log_path}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

export async function executeRun(flags: RunFlags): Promise<void> {
  const ctx = await startLatticeRun(flags);
  let childExit = 1;
  let captured: { stdout: string; stderr: string } | undefined;
  try {
    const finished = await ctx.child;
    childExit = finished.exitCode ?? (finished.failed ? 1 : 0);
    if (flags.captureChild) {
      captured = {
        stdout: asText(finished.stdout),
        stderr: asText(finished.stderr),
      };
    }
  } catch (err) {
    if (err instanceof BusPersistError) {
      await shutdownRun(ctx).catch(() => undefined);
      fail(err.message, {
        json: flags.json,
        command: "run",
        code: "BUS_PERSIST",
        exitCode: 4,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as NodeJS.ErrnoException).code;
    childExit = code === "ENOENT" ? 127 : 1;
    captured = { stdout: "", stderr: message };
  }

  let result: RunResult;
  try {
    result = await finishLatticeRun(ctx, flags, childExit, captured);
  } catch (err) {
    if (err instanceof BusPersistError) {
      fail(err.message, {
        json: flags.json,
        command: "run",
        code: "BUS_PERSIST",
        exitCode: 4,
      });
    }
    throw err;
  }

  const ok = childExit === 0;
  printRunResult(result, flags, ok);
  if (!ok) {
    process.exit(2);
  }
}

export function runFlagsFromOpts(
  opts: Record<string, unknown>,
  globals: { json?: boolean; verbose?: boolean; quiet?: boolean },
  extras: { captureChild?: boolean } = {},
): RunFlags {
  const attachRaw = String(opts.attach ?? "openai-completions");
  if (!isAttachKitId(attachRaw)) {
    fail(`unknown attach kit: ${attachRaw}`, {
      json: globals.json === true,
      command: "run",
      code: "USAGE",
    });
  }
  let timeoutMs = 0;
  try {
    timeoutMs = parseNonNegInt(opts.timeoutMs, 0, "--timeout-ms");
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), {
      json: globals.json === true,
      command: "run",
      code: "USAGE",
    });
  }
  const json = globals.json === true;
  return {
    cmd: String(opts.cmd ?? ""),
    attach: attachRaw,
    adapters: opts.adapters as string | undefined,
    envFile: opts.envFile as string | undefined,
    timeoutMs,
    runId: opts.runId as string | undefined,
    sessionId: opts.sessionId as string | undefined,
    fixtureBeliefs: opts.fixtureBeliefs as string | undefined,
    fixtureApprovals: opts.fixtureApprovals as string | undefined,
    failOnSync: opts.failOnSync === true,
    json,
    verbose: globals.verbose === true,
    quiet: globals.quiet === true,
    captureChild: extras.captureChild ?? json,
  };
}

export function addRunOptions(cmd: Command): Command {
  cmd
    .requiredOption("--cmd <string>", "Command to spawn")
    .addOption(
      new Option("--attach <kit>", "Attach kit id")
        .choices([
          "openai-completions",
          "openai-agents",
          "hermes",
          "langgraph",
          "custom",
        ])
        .default("openai-completions"),
    )
    .option(
      "--adapters <list>",
      "Temporary overlay, cannot enable an adapter not in config",
    )
    .option("--env-file <path>", "Loaded via dotenv without overriding existing env")
    .option("--timeout-ms <n>", "0 means no timeout. Else SIGTERM at n, SIGKILL at n+5000", "0")
    .option("--run-id <ulid>", "Reuse a run id for resume of the JSONL only")
    .option("--session-id <id>", "Sets x-axion-session and LATTICEAG_SESSION_ID")
    .option("--fixture-beliefs <path>", "Axion adapter reads fixtures instead of webhook")
    .option("--fixture-approvals <path>", "VekInbox adapter reads fixtures")
    .option("--fail-on-sync", "Exit 5 if sync outbox remains non-empty");
  return cmd;
}

export function registerRun(program: Command): void {
  const cmd = program
    .command("run")
    .description("Attach and execute.")
    .action(async (opts: Record<string, unknown>, command: Command) => {
      const globals = readGlobalOpts(command);
      await executeRun(runFlagsFromOpts(opts, globals));
    });
  addRunOptions(cmd);
  addGlobalOptions(cmd);
}

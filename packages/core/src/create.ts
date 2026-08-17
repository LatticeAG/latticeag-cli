import { resolve } from "node:path";
import type { LatticeagConfig } from "@latticeag/config";
import {
  ConfigNotFoundError,
  ConfigSchemaError,
  loadConfig,
} from "@latticeag/config";
import { ulid } from "ulid";
import { ConfigError, ChildModeError } from "./errors.js";
import { overlayCreateOptions, type CreateOptionsOverlay } from "./overlay.js";
import { assertNotWindows } from "./platform.js";
import { createOwnerBus, type LatticeBus } from "./owner-bus.js";
import { IngestBus } from "./child-bus.js";
import { startIngestHost, type IngestHandle } from "./ingest-host.js";
import { startAutoAdapters } from "./auto.js";
import type { LatticeAGCreateOptions } from "./types.js";
import type { BusLike } from "./stages/types.js";

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SES_RE = /^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export interface CreatedLattice {
  mode: "owner" | "child";
  run_id: string;
  session_id: string;
  config: LatticeagConfig;
  overlay: CreateOptionsOverlay;
  cwd: string;
  env: NodeJS.ProcessEnv;
  bus: BusLike;
  log_path: string;
  abort: AbortSignal;
  ingest: IngestHandle | undefined;
  adapterStops: Array<() => Promise<void>>;
}

export async function createLattice(opts: LatticeAGCreateOptions = {}): Promise<CreatedLattice> {
  assertNotWindows();
  const env = opts.env ?? process.env;
  if (opts.sync === true) {
    throw new ConfigError("SYNC_CLI_ONLY", "Event replication is latticeag sync, not @latticeag/core.");
  }

  const ingestSet = Boolean(env.LATTICEAG_INGEST_URL && env.LATTICEAG_RUN_ID);
  if (opts.forceOwner === true && ingestSet && env.LATTICEAG_CORE_ALLOW_NESTED_OWNER !== "1") {
    throw new ChildModeError(
      "CHILD_NESTED_OWNER",
      "forceOwner is set while LATTICEAG_INGEST_URL is present",
    );
  }
  const mode: "owner" | "child" =
    ingestSet && opts.forceOwner !== true ? "child" : "owner";

  const cwd = resolve(opts.cwd ?? process.cwd());
  const prevConfig = process.env.LATTICEAG_CONFIG;
  if (opts.configPath) {
    process.env.LATTICEAG_CONFIG = opts.configPath;
  } else if (env.LATTICEAG_CONFIG && env !== process.env) {
    process.env.LATTICEAG_CONFIG = env.LATTICEAG_CONFIG;
  }
  let loaded;
  try {
    loaded = loadConfig(cwd);
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      throw new ConfigError(
        "CONFIG_NOT_FOUND",
        `latticeag.json not found from ${cwd}. Run latticeag init or pass configPath.`,
        { cause: err },
      );
    }
    if (err instanceof ConfigSchemaError) {
      const issue = err.issues[0];
      const path = issue ? issue.path.join(".") : "";
      throw new ConfigError("CONFIG_INVALID", `${err.message}${path ? ` (${path})` : ""}`, {
        cause: err,
      });
    }
    throw err;
  } finally {
    if (prevConfig === undefined) {
      delete process.env.LATTICEAG_CONFIG;
    } else {
      process.env.LATTICEAG_CONFIG = prevConfig;
    }
  }

  const overlay = overlayCreateOptions(opts, env);
  const run_id =
    mode === "child"
      ? (env.LATTICEAG_RUN_ID as string)
      : opts.run_id && ULID_RE.test(opts.run_id)
        ? opts.run_id
        : ulid();
  const session_id =
    mode === "child"
      ? (env.LATTICEAG_SESSION_ID ?? `ses_${ulid()}`)
      : sessionFromOpts(opts.session_id);

  const log_path = resolve(cwd, opts.bus?.log_path ?? loaded.config.bus.log_path);
  const redact_keys = [...loaded.config.redaction.keys];
  const include_raw_text = loaded.config.redaction.include_raw_text;

  let bus: BusLike;
  if (mode === "owner") {
    bus = createOwnerBus({
      run_id,
      session_id,
      log_path,
      ring_capacity: opts.bus?.ring_capacity ?? loaded.config.bus.ring_capacity,
      overflow_block_ms: opts.bus?.overflow_block_ms ?? loaded.config.bus.overflow_block_ms,
      overflow: opts.bus?.overflow ?? loaded.config.bus.overflow,
      persist_fail: opts.bus?.persist_fail ?? loaded.config.bus.persist_fail,
      redact_keys,
      include_raw_text,
      max_log_bytes: opts.bus?.max_log_bytes ?? loaded.config.bus.max_log_bytes,
    });
  } else {
    bus = new IngestBus({
      ingest_url: env.LATTICEAG_INGEST_URL as string,
      run_id,
      session_id,
      log_path: env.LATTICEAG_EVENTS_PATH,
      redact_keys,
      include_raw_text,
      overflow_block_ms: loaded.config.bus.overflow_block_ms,
    });
  }

  const abort = opts.abort ?? new AbortController().signal;
  let ingest: IngestHandle | undefined;
  if (overlay.ingest && mode === "owner") {
    ingest = await startIngestHost(loaded.config, bus as LatticeBus, env);
  }

  const adapterStops: Array<() => Promise<void>> = [];
  if (mode === "owner") {
    adapterStops.push(
      ...(await startAutoAdapters(overlay.auto, loaded.config, bus as LatticeBus, cwd, env, abort)),
    );
  }

  return {
    mode,
    run_id,
    session_id,
    config: loaded.config,
    overlay,
    cwd,
    env,
    bus,
    log_path,
    abort,
    ingest,
    adapterStops,
  };
}

function sessionFromOpts(value: string | undefined): string {
  if (value && (SES_RE.test(value) || (value.length >= 1 && value.length <= 128))) {
    return value;
  }
  return `ses_${ulid()}`;
}

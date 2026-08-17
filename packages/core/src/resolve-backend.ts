import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LatticeagConfig } from "@latticeag/config";
import { BackendUnresolvedError, type ProbeLogEntry } from "./errors.js";
import type {
  BackendKind,
  LatticeAGCreateOptions,
  ResolvedBackend,
  StageBackendOverride,
  StageId,
} from "./types.js";
import type { CreateOptionsOverlay } from "./overlay.js";

const requireFromHere = createRequire(import.meta.url);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export interface ResolveBackendContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  config: LatticeagConfig;
  overlay: CreateOptionsOverlay;
  registered: ReadonlySet<StageId>;
  fetchImpl: typeof fetch;
  cache: Map<StageId, ResolvedBackend>;
}

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function isLoopbackUrl(url: string): boolean {
  const host = hostnameOf(url);
  return host !== undefined && LOOPBACK.has(host);
}

function defaultTimeout(stage: StageId): number {
  if (stage === "verify") return 15000;
  if (stage === "approve") return 3_600_000;
  if (stage === "inspect") return 2000;
  if (stage === "record") return 5000;
  return 15000;
}

function fixturePathFor(
  stage: StageId,
  ctx: ResolveBackendContext,
  override: StageBackendOverride | undefined,
): string | undefined {
  if (override?.fixture) {
    return resolvePath(ctx.cwd, override.fixture);
  }
  const fixtures = ctx.overlay.fixtures;
  if (stage === "inspect" && fixtures.beliefs) return resolvePath(ctx.cwd, fixtures.beliefs);
  if (stage === "verify" && fixtures.verdicts) return resolvePath(ctx.cwd, fixtures.verdicts);
  if (stage === "approve" && fixtures.approvals) return resolvePath(ctx.cwd, fixtures.approvals);
  if (stage === "receipt") {
    if (fixtures.receipts) return resolvePath(ctx.cwd, fixtures.receipts);
    if (fixtures.approvals) return resolvePath(ctx.cwd, fixtures.approvals);
  }
  if (stage === "record") {
    return resolvePath(
      ctx.cwd,
      fileURLToPath(new URL("../fixtures/session-recorded.json", import.meta.url)),
    );
  }
  return undefined;
}

async function fileParses(path: string): Promise<boolean> {
  if (!existsSync(path)) {
    return false;
  }
  try {
    JSON.parse(await readFile(path, "utf8"));
    return true;
  } catch {
    return false;
  }
}

async function probeHttp(
  url: string,
  timeout_ms: number,
  fetchImpl: typeof fetch,
  accept: (status: number, body: string) => boolean,
): Promise<{ ok: boolean; detail: string; duration_ms: number }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    const body = await res.text();
    const ok = accept(res.status, body);
    return { ok, detail: `${url} ${res.status}`, duration_ms: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${url} ${message}`, duration_ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

function visreplayLocalOk(): { ok: boolean; detail: string } {
  try {
    requireFromHere.resolve("@latticeag/visreplay");
    return { ok: true, detail: "require.resolve(@latticeag/visreplay)" };
  } catch {
    // TODO(cli-integration): drop stub success when the visreplay npm package is a workspace dep
    return { ok: true, detail: "in-process visreplay wrap (adapter package not installed)" };
  }
}

function originHealthUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}/health`;
}

async function probeKind(
  stage: StageId,
  kind: BackendKind,
  ctx: ResolveBackendContext,
  override: StageBackendOverride | undefined,
): Promise<ProbeLogEntry> {
  const start = Date.now();
  if (stage === "record" && (kind === "proxy" || kind === "hosted")) {
    return {
      kind,
      ok: false,
      detail: "visreplay is local-only in v0.1",
      duration_ms: Date.now() - start,
    };
  }
  if ((stage === "shield" || stage === "compensate" || stage === "break_loop") && (kind === "proxy" || kind === "hosted")) {
    return {
      kind,
      ok: false,
      detail: `${stage} ${kind} invalid in v0.1`,
      duration_ms: Date.now() - start,
    };
  }

  if (kind === "fixture") {
    if (stage === "compensate" || stage === "break_loop") {
      const ok = ctx.registered.has(stage);
      return {
        kind,
        ok,
        detail: ok ? `registered handler ${stage}` : `no registered handler ${stage}`,
        duration_ms: Date.now() - start,
      };
    }
    const path = fixturePathFor(stage, ctx, override);
    if (path === undefined) {
      return { kind, ok: false, detail: "no fixture path", duration_ms: Date.now() - start };
    }
    const ok = await fileParses(path);
    return {
      kind,
      ok,
      detail: ok ? path : `fixture missing or invalid: ${path}`,
      duration_ms: Date.now() - start,
    };
  }

  const timeout = kind === "hosted" ? 1000 : 200;
  const env = ctx.env;
  const axionBase = ctx.config.adapters.axion.base_url;
  const gateway = env.LEXGATEWAY_URL ?? "http://127.0.0.1:8788";
  const lexverdict = env.LEXVERDICT_URL;
  const vekinbox = env.VEKINBOX_URL;

  if (kind === "local") {
    if (stage === "inspect") {
      const probed = await probeHttp(`${axionBase.replace(/\/$/, "")}/api/health`, timeout, ctx.fetchImpl, (s) => s === 200);
      return { kind, ...probed };
    }
    if (stage === "verify") {
      if (!lexverdict) {
        return { kind, ok: false, detail: "LEXVERDICT_URL unset", duration_ms: Date.now() - start };
      }
      const probed = await probeHttp(
        `${lexverdict.replace(/\/$/, "")}/health`,
        timeout,
        ctx.fetchImpl,
        (s, body) => s === 200 || body.includes("degraded"),
      );
      return { kind, ...probed };
    }
    if (stage === "approve" || stage === "receipt") {
      if (!vekinbox) {
        return { kind, ok: false, detail: "VEKINBOX_URL unset", duration_ms: Date.now() - start };
      }
      const probed = await probeHttp(originHealthUrl(vekinbox), timeout, ctx.fetchImpl, (s, body) => {
        if (s !== 200) return false;
        try {
          return (JSON.parse(body) as { status?: string }).status === "ok";
        } catch {
          return false;
        }
      });
      return { kind, ...probed };
    }
    if (stage === "record") {
      const local = visreplayLocalOk();
      return { kind, ok: local.ok, detail: local.detail, duration_ms: Date.now() - start };
    }
    if (stage === "shield") {
      try {
        requireFromHere.resolve("@latticeag/lexshield");
        return { kind, ok: true, detail: "import @latticeag/lexshield", duration_ms: Date.now() - start };
      } catch {
        return { kind, ok: false, detail: "lexshield missing", duration_ms: Date.now() - start };
      }
    }
    if (stage === "compensate" || stage === "break_loop") {
      const ok = ctx.registered.has(stage);
      return {
        kind,
        ok,
        detail: ok ? `registered handler ${stage}` : `no registered handler ${stage}`,
        duration_ms: Date.now() - start,
      };
    }
  }

  if (kind === "proxy") {
    if ((stage === "verify" || stage === "approve" || stage === "receipt") && !env.LEXGATEWAY_URL) {
      return { kind, ok: false, detail: "LEXGATEWAY_URL unset", duration_ms: Date.now() - start };
    }
    if (stage === "verify" && !lexverdict) {
      return { kind, ok: false, detail: "LEXVERDICT_URL unset", duration_ms: Date.now() - start };
    }
    if ((stage === "approve" || stage === "receipt") && !vekinbox) {
      return { kind, ok: false, detail: "VEKINBOX_URL unset", duration_ms: Date.now() - start };
    }
    const probed = await probeHttp(`${gateway.replace(/\/$/, "")}/health`, timeout, ctx.fetchImpl, (s) => s === 200);
    return { kind, ...probed };
  }

  // hosted
  if (stage === "inspect") {
    const hosted = env.AXION_HOSTED_URL ?? (isLoopbackUrl(axionBase) ? undefined : axionBase);
    if (!hosted) {
      return { kind, ok: false, detail: "no hosted axion url", duration_ms: Date.now() - start };
    }
    const probed = await probeHttp(`${hosted.replace(/\/$/, "")}/api/health`, timeout, ctx.fetchImpl, (s) => s === 200);
    return { kind, ...probed };
  }
  if (stage === "verify") {
    if (!lexverdict || isLoopbackUrl(lexverdict)) {
      return { kind, ok: false, detail: "hosted lexverdict requires non-loopback LEXVERDICT_URL", duration_ms: Date.now() - start };
    }
    const probed = await probeHttp(lexverdict, timeout, ctx.fetchImpl, (s) => s === 200 || s === 404);
    return { kind, ...probed };
  }
  if (stage === "approve" || stage === "receipt") {
    if (!vekinbox || isLoopbackUrl(vekinbox)) {
      return { kind, ok: false, detail: "hosted vekinbox requires non-loopback VEKINBOX_URL", duration_ms: Date.now() - start };
    }
    const probed = await probeHttp(originHealthUrl(vekinbox), timeout, ctx.fetchImpl, (s) => s === 200);
    return { kind, ...probed };
  }

  return { kind, ok: false, detail: `${stage} ${kind} not probed`, duration_ms: Date.now() - start };
}

export async function resolveBackend(
  stage: StageId,
  ctx: ResolveBackendContext,
): Promise<ResolvedBackend> {
  const cached = ctx.cache.get(stage);
  if (cached) {
    return cached;
  }
  const override = ctx.overlay.stages[stage];
  const timeout_ms = override?.timeout_ms ?? ctx.config.adapters.lexverdict.timeout_ms ?? defaultTimeout(stage);

  if (override?.backend !== undefined) {
    const probe = await probeKind(stage, override.backend, ctx, override);
    if (!probe.ok) {
      throw new BackendUnresolvedError(
        `backend ${override.backend} failed for ${stage}: ${probe.detail}`,
        [probe],
      );
    }
    const resolved: ResolvedBackend = {
      stage,
      kind: override.backend,
      detail: probe.detail,
      timeout_ms: override.timeout_ms ?? defaultTimeout(stage),
    };
    ctx.cache.set(stage, resolved);
    return resolved;
  }

  const fixtureProbe = await probeKind(stage, "fixture", ctx, override);
  if (fixtureProbe.ok) {
    const resolved: ResolvedBackend = {
      stage,
      kind: "fixture",
      detail: fixtureProbe.detail,
      timeout_ms,
    };
    ctx.cache.set(stage, resolved);
    return resolved;
  }

  const probes: ProbeLogEntry[] = [];
  for (const kind of ["local", "proxy", "hosted"] as const) {
    const probe = await probeKind(stage, kind, ctx, override);
    probes.push(probe);
    if (probe.ok) {
      const resolved: ResolvedBackend = {
        stage,
        kind,
        detail: probe.detail,
        timeout_ms,
      };
      ctx.cache.set(stage, resolved);
      return resolved;
    }
  }

  throw new BackendUnresolvedError(`no backend for ${stage}`, probes);
}

export function lookupFixturePath(
  stage: StageId,
  ctx: ResolveBackendContext,
): string | undefined {
  return fixturePathFor(stage, ctx, ctx.overlay.stages[stage]);
}

export type { LatticeAGCreateOptions };

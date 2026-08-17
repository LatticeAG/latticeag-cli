import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import {
  discoverConfig,
  formatZodIssue,
  parseJsonStrict,
  readConfigFile,
  ConfigParseError,
  ConfigSchemaError,
  type LatticeagConfig,
} from "@latticeag/config";
import { addGlobalOptions, readGlobalOpts } from "../globals.js";
import { writeJson } from "../json-envelope.js";
import { CLI_VERSION } from "../cli-version.js";
import { resolvePackageVersion } from "../package-version.js";
import { ENV_EXAMPLE, GITIGNORE_RULES } from "./env-example.js";

const execFileAsync = promisify(execFile);
const requireFromCli = createRequire(fileURLToPath(new URL(".", import.meta.url)));

export const LATTICEAG_DOCTOR_ALLOW_MISSING_ADAPTERS =
  "LATTICEAG_DOCTOR_ALLOW_MISSING_ADAPTERS";

export type DoctorStatus = "pass" | "fail" | "warn" | "skip";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  detail: string;
  presence?: "present" | "absent" | "not_applicable";
  chars?: number;
}

export interface DoctorSecretCheck {
  id: string;
  status: DoctorStatus;
  presence: "present" | "absent" | "not_applicable";
  chars?: number;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  fix_applied: string[];
}

const ID_WIDTH = 34;

export const DOCTOR_CHECK_IDS = [
  "node_version",
  "config_present",
  "config_valid",
  "events_package",
  "log_writable",
  "ingest_port",
  "adapter_axion",
  "adapter_visreplay",
  "adapter_lexverdict",
  "adapter_vekinbox",
  "adapter_viscompile",
  "adapter_lexshield",
  "env_OPENAI_API_KEY",
  "env_AXION_READ_TOKEN",
  "env_AXION_WEBHOOK_SECRET",
  "env_LEXVERDICT_URL",
  "env_VEKINBOX_API_KEY",
  "env_VEKINBOX_URL",
  "env_VEKINBOX_WORKSPACE_ID",
  "env_VEKINBOX_AGENT_ID",
  "env_LEXGATEWAY_URL",
  "env_LEXGATEWAY_TOKEN",
  "axion_health",
  "lexverdict_health",
  "vekinbox_health",
  "repo_freshness",
  "secrets_not_in_config",
  "port_collision_axion_lexverdict",
] as const;

export function formatDoctorLine(check: DoctorCheck): string {
  return `${check.status.padEnd(4)}  ${check.id.padEnd(ID_WIDTH)} ${check.detail}`;
}

export function nodeSatisfies(version: string): boolean {
  const parts = version.split(".").map((p) => Number(p));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  if (major === 20) {
    return minor >= 19;
  }
  return major > 20;
}

function allowMissingAdapters(): boolean {
  return process.env[LATTICEAG_DOCTOR_ALLOW_MISSING_ADAPTERS] === "1";
}

function check(
  id: string,
  status: DoctorStatus,
  detail: string,
  extra: Partial<DoctorCheck> = {},
): DoctorCheck {
  return { id, status, detail, ...extra };
}

function secretCheck(
  id: string,
  status: DoctorStatus,
  presence: DoctorSecretCheck["presence"],
  detail: string,
  chars?: number,
): DoctorCheck {
  const row: DoctorCheck = { id, status, detail, presence };
  if (chars !== undefined) {
    row.chars = chars;
  }
  return row;
}

function presentChars(name: string): { presence: "present"; chars: number; detail: string } | { presence: "absent"; detail: string } {
  const value = process.env[name];
  if (value !== undefined && value.length > 0) {
    return {
      presence: "present",
      chars: value.length,
      detail: `present (chars=${value.length})`,
    };
  }
  return { presence: "absent", detail: "absent" };
}

function isUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function hostPort(urlStr: string): string | undefined {
  try {
    const u = new URL(urlStr);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return `${u.hostname}:${port}`;
  } catch {
    return undefined;
  }
}

async function canImport(specifier: string): Promise<boolean> {
  try {
    await import(specifier);
    return true;
  } catch {
    try {
      requireFromCli.resolve(specifier);
      return true;
    } catch {
      return false;
    }
  }
}

function whichOnPath(bin: string): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    const normalized = dir.replace(/[/\\]+$/, "");
    if (
      normalized.endsWith(`${path.sep}node_modules${path.sep}.bin`) ||
      normalized.endsWith(`${path.sep}node_modules/.bin`)
    ) {
      continue;
    }
    const candidate = path.join(dir, bin);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function portListen(bind: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, bind, () => {
      server.close(() => resolve(true));
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ingestPidOwns(cwd: string): { ok: boolean; pid?: number } {
  const pidPath = path.join(cwd, ".latticeag", "ingest.pid");
  if (!existsSync(pidPath)) {
    return { ok: false };
  }
  const raw = readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false };
  }
  if (pidAlive(pid)) {
    return { ok: true, pid };
  }
  return { ok: false, pid };
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out);
    }
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{10,}/,
  /vk_live_/,
  /vk_test_/,
  /AIza/,
  /ghp_/,
  /-----BEGIN/,
];

function scanSecrets(raw: unknown): string[] {
  const strings: string[] = [];
  collectStrings(raw, strings);
  const hits: string[] = [];
  for (const s of strings) {
    for (const re of SECRET_PATTERNS) {
      if (re.test(s)) {
        hits.push(re.source);
      }
    }
  }
  return hits;
}

async function spawnCapture(
  file: string,
  args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: 8000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return { status: 0, stdout, stderr };
  } catch (err) {
    const e = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    const status = typeof e.code === "number" ? e.code : 1;
    return {
      status,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

async function httpJson(
  url: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    clearTimeout(t);
  }
}

function cliEventsRange(): string {
  try {
    const pkgPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return pkg.dependencies?.["@latticeag/events"] ?? CLI_VERSION;
  } catch {
    return CLI_VERSION;
  }
}

function writeConfigFile(filePath: string, config: LatticeagConfig): void {
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

function applyGitignoreFix(cwd: string): boolean {
  const gitignorePath = path.join(cwd, ".gitignore");
  let existing = "";
  if (existsSync(gitignorePath)) {
    existing = readFileSync(gitignorePath, "utf8");
  }
  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  const missing = GITIGNORE_RULES.filter((rule) => !existingLines.has(rule));
  if (missing.length === 0) {
    return false;
  }
  const prefix =
    existing.length === 0
      ? "# latticeag\n"
      : existing.endsWith("\n")
        ? "\n# latticeag\n"
        : "\n\n# latticeag\n";
  writeFileSync(gitignorePath, `${existing}${prefix}${missing.join("\n")}\n`);
  return true;
}

export async function runDoctorChecks(options: {
  offline: boolean;
  fix: boolean;
  cwd: string;
}): Promise<DoctorResult> {
  const { offline, fix, cwd } = options;
  const checks: DoctorCheck[] = [];
  const fix_applied: string[] = [];

  if (fix) {
    const latticeDir = path.join(cwd, ".latticeag");
    if (!existsSync(latticeDir)) {
      mkdirSync(latticeDir, { recursive: true });
      fix_applied.push("mkdir:.latticeag");
    }
    const envExample = path.join(cwd, ".env.example");
    if (!existsSync(envExample)) {
      writeFileSync(envExample, ENV_EXAMPLE);
      fix_applied.push("wrote:.env.example");
    }
    if (applyGitignoreFix(cwd)) {
      fix_applied.push("gitignore");
    }
  }

  const nodeVer = process.versions.node;
  checks.push(
    check(
      "node_version",
      nodeSatisfies(nodeVer) ? "pass" : "fail",
      nodeVer,
    ),
  );

  const discovered = discoverConfig(cwd);
  if (!discovered) {
    checks.push(check("config_present", "fail", "not found"));
    checks.push(check("config_valid", "skip", "no config"));
  } else if (!existsSync(discovered.path)) {
    checks.push(
      check(
        "config_present",
        "fail",
        discovered.from_env
          ? `LATTICEAG_CONFIG not found: ${discovered.path}`
          : "not found",
      ),
    );
    checks.push(check("config_valid", "skip", "no config"));
  } else if (discovered.from_env) {
    checks.push(
      check("config_present", "warn", `config_override ${discovered.path}`),
    );
  } else {
    checks.push(check("config_present", "pass", discovered.path));
  }

  let config: LatticeagConfig | undefined;
  let configPath: string | undefined;
  if (discovered && existsSync(discovered.path)) {
    configPath = discovered.path;
    try {
      config = readConfigFile(discovered.path);
      checks.push(
        check("config_valid", "pass", `schema_version=${config.schema_version}`),
      );
    } catch (err) {
      if (err instanceof ConfigParseError) {
        checks.push(
          check(
            "config_valid",
            "fail",
            `parse byte offset ${err.byteOffset}`,
          ),
        );
      } else if (err instanceof ConfigSchemaError) {
        const first = err.issues[0];
        checks.push(
          check(
            "config_valid",
            "fail",
            first ? formatZodIssue(first) : err.message,
          ),
        );
      } else {
        checks.push(
          check(
            "config_valid",
            "fail",
            err instanceof Error ? err.message : String(err),
          ),
        );
      }
    }
  }

  const eventsVersion = resolvePackageVersion("@latticeag/events");
  const eventsRange = cliEventsRange();
  let eventsImportOk = false;
  try {
    await import("@latticeag/events");
    eventsImportOk = true;
  } catch {
    eventsImportOk = false;
  }
  if (!eventsVersion || !eventsImportOk) {
    checks.push(check("events_package", "fail", "not resolved"));
  } else if (eventsVersion === CLI_VERSION || eventsVersion === "0.1.0") {
    checks.push(
      check(
        "events_package",
        "pass",
        `${eventsVersion} (cli dep ${eventsRange})`,
      ),
    );
  } else {
    checks.push(
      check(
        "events_package",
        "fail",
        `mismatch events=${eventsVersion} cli-dep=${eventsRange}`,
      ),
    );
  }

  if (!config) {
    checks.push(check("log_writable", "skip", "no config"));
    checks.push(check("ingest_port", "skip", "no config"));
  } else {
    const logPath = path.resolve(cwd, config.bus.log_path);
    const parent = path.dirname(logPath);
    try {
      if (!existsSync(parent)) {
        if (fix) {
          mkdirSync(parent, { recursive: true });
          if (!fix_applied.includes("mkdir:.latticeag")) {
            fix_applied.push(`mkdir:${path.relative(cwd, parent) || "."}`);
          }
        } else {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
      }
      const fd = openSync(logPath, "a");
      closeSync(fd);
      checks.push(check("log_writable", "pass", parent));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "error";
      checks.push(check("log_writable", "fail", String(code)));
    }

    const bind = config.ingest.bind;
    const port = config.ingest.port;
    const free = await portListen(bind, port);
    const owned = ingestPidOwns(cwd);
    if (free) {
      checks.push(check("ingest_port", "pass", `${bind}:${port}`));
    } else if (owned.ok) {
      checks.push(
        check(
          "ingest_port",
          "pass",
          `${bind}:${port} owned by pid ${owned.pid}`,
        ),
      );
    } else if (fix && configPath) {
      let rewritten: number | undefined;
      for (let candidate = 9848; candidate <= 9857; candidate++) {
        if (await portListen(bind, candidate)) {
          rewritten = candidate;
          break;
        }
      }
      if (rewritten !== undefined) {
        config = { ...config, ingest: { ...config.ingest, port: rewritten } };
        writeConfigFile(configPath, config);
        fix_applied.push(`ingest.port:${rewritten}`);
        checks.push(
          check("ingest_port", "pass", `${bind}:${rewritten}`),
        );
      } else {
        checks.push(
          check("ingest_port", "fail", `EADDRINUSE ${bind}:${port}`),
        );
      }
    } else {
      checks.push(check("ingest_port", "fail", `EADDRINUSE ${bind}:${port}`));
    }
  }

  async function adapterPackageCheck(
    id: string,
    enabled: boolean | undefined,
    specifiers: string[],
  ): Promise<void> {
    if (!enabled) {
      checks.push(check(id, "skip", "adapter not enabled"));
      return;
    }
    const missing: string[] = [];
    for (const spec of specifiers) {
      if (!(await canImport(spec))) {
        missing.push(spec);
      }
    }
    if (missing.length === 0) {
      checks.push(check(id, "pass", specifiers.join(", ")));
      return;
    }
    if (allowMissingAdapters()) {
      checks.push(check(id, "skip", `adapter_missing ${missing.join(", ")}`));
      return;
    }
    checks.push(check(id, "fail", `adapter_missing ${missing.join(", ")}`));
  }

  await adapterPackageCheck("adapter_axion", config?.adapters.axion.enabled, [
    "@latticeag/adapter-axion",
  ]);
  await adapterPackageCheck(
    "adapter_visreplay",
    config?.adapters.visreplay.enabled,
    ["@latticeag/visreplay", "@latticeag/adapter-visreplay"],
  );
  await adapterPackageCheck(
    "adapter_lexverdict",
    config?.adapters.lexverdict.enabled,
    ["@latticeag/adapter-lexverdict"],
  );
  await adapterPackageCheck(
    "adapter_vekinbox",
    config?.adapters.vekinbox.enabled,
    ["@latticeag/adapter-vekinbox"],
  );

  if (!config?.adapters.viscompile.enabled) {
    checks.push(check("adapter_viscompile", "skip", "adapter not enabled"));
  } else {
    const bin = whichOnPath(config.adapters.viscompile.bin);
    if (!bin) {
      if (allowMissingAdapters()) {
        checks.push(check("adapter_viscompile", "skip", "adapter_missing lattice"));
      } else {
        checks.push(check("adapter_viscompile", "fail", "adapter_missing lattice"));
      }
    } else {
      const result = await spawnCapture(bin, ["--version"]);
      if (result.status === 0) {
        checks.push(
          check(
            "adapter_viscompile",
            "pass",
            (result.stdout || result.stderr).trim().split("\n")[0] ?? "ok",
          ),
        );
      } else if (allowMissingAdapters()) {
        checks.push(check("adapter_viscompile", "skip", "lattice --version failed"));
      } else {
        checks.push(check("adapter_viscompile", "fail", "lattice --version failed"));
      }
    }
  }

  if (!config?.adapters.lexshield.enabled) {
    checks.push(check("adapter_lexshield", "skip", "adapter not enabled"));
  } else {
    const bin = whichOnPath(config.adapters.lexshield.bin);
    if (!bin) {
      if (allowMissingAdapters()) {
        checks.push(check("adapter_lexshield", "skip", "adapter_missing lexshield"));
      } else {
        checks.push(check("adapter_lexshield", "fail", "adapter_missing lexshield"));
      }
    } else {
      const help = await spawnCapture(bin, ["--help"]);
      const evalHelp = await spawnCapture(bin, ["evaluate", "--help"]);
      const docsJson = `${evalHelp.stdout}\n${evalHelp.stderr}`.includes("--json");
      if (help.status === 0 && evalHelp.status === 0 && docsJson) {
        checks.push(check("adapter_lexshield", "pass", "lexshield evaluate --json"));
      } else if (allowMissingAdapters()) {
        checks.push(check("adapter_lexshield", "skip", "lexshield evaluate --json missing"));
      } else {
        checks.push(check("adapter_lexshield", "fail", "lexshield evaluate --json missing"));
      }
    }
  }

  {
    const p = presentChars("OPENAI_API_KEY");
    if (p.presence === "present") {
      checks.push(secretCheck("env_OPENAI_API_KEY", "pass", "present", p.detail, p.chars));
    } else {
      checks.push(secretCheck("env_OPENAI_API_KEY", "warn", "absent", "absent"));
    }
  }

  if (!config?.adapters.axion.enabled || config.adapters.axion.mode !== "poll") {
    checks.push(
      secretCheck(
        "env_AXION_READ_TOKEN",
        "skip",
        "not_applicable",
        "not required",
      ),
    );
  } else {
    const p = presentChars("AXION_READ_TOKEN");
    if (p.presence === "present") {
      checks.push(
        secretCheck("env_AXION_READ_TOKEN", "pass", "present", p.detail, p.chars),
      );
    } else {
      checks.push(secretCheck("env_AXION_READ_TOKEN", "fail", "absent", "absent"));
    }
  }

  if (
    !config?.adapters.axion.enabled ||
    config.adapters.axion.mode !== "webhook"
  ) {
    checks.push(
      secretCheck(
        "env_AXION_WEBHOOK_SECRET",
        "skip",
        "not_applicable",
        "not required",
      ),
    );
  } else {
    const p = presentChars("AXION_WEBHOOK_SECRET");
    const unsigned = process.env.AXION_WEBHOOK_ALLOW_UNSIGNED === "true";
    if (p.presence === "present") {
      checks.push(
        secretCheck(
          "env_AXION_WEBHOOK_SECRET",
          "pass",
          "present",
          p.detail,
          p.chars,
        ),
      );
    } else if (unsigned) {
      checks.push(
        secretCheck(
          "env_AXION_WEBHOOK_SECRET",
          "pass",
          "absent",
          "unsigned allowed",
        ),
      );
    } else {
      checks.push(
        secretCheck("env_AXION_WEBHOOK_SECRET", "fail", "absent", "absent"),
      );
    }
  }

  function envRequired(
    id: string,
    name: string,
    needed: boolean,
    validate?: (value: string) => string | undefined,
  ): void {
    if (!needed) {
      checks.push(secretCheck(id, "skip", "not_applicable", "not required"));
      return;
    }
    const p = presentChars(name);
    if (p.presence !== "present") {
      checks.push(secretCheck(id, "fail", "absent", "absent"));
      return;
    }
    const value = process.env[name] ?? "";
    const invalid = validate?.(value);
    if (invalid) {
      checks.push(secretCheck(id, "fail", "present", invalid, p.chars));
      return;
    }
    checks.push(secretCheck(id, "pass", "present", p.detail, p.chars));
  }

  envRequired(
    "env_LEXVERDICT_URL",
    "LEXVERDICT_URL",
    config?.adapters.lexverdict.enabled === true,
    (value) => (isUrl(value) ? undefined : "must be URL"),
  );
  envRequired(
    "env_VEKINBOX_API_KEY",
    "VEKINBOX_API_KEY",
    config?.adapters.vekinbox.enabled === true,
    (value) =>
      value.startsWith("vk_live_") || value.startsWith("vk_test_")
        ? undefined
        : "invalid prefix",
  );
  envRequired(
    "env_VEKINBOX_URL",
    "VEKINBOX_URL",
    config?.adapters.vekinbox.enabled === true,
  );
  envRequired(
    "env_VEKINBOX_WORKSPACE_ID",
    "VEKINBOX_WORKSPACE_ID",
    config?.adapters.vekinbox.enabled === true,
  );
  envRequired(
    "env_VEKINBOX_AGENT_ID",
    "VEKINBOX_AGENT_ID",
    config?.adapters.vekinbox.enabled === true,
  );
  envRequired(
    "env_LEXGATEWAY_URL",
    "LEXGATEWAY_URL",
    config?.sync.enabled === true,
  );
  envRequired(
    "env_LEXGATEWAY_TOKEN",
    "LEXGATEWAY_TOKEN",
    config?.sync.enabled === true,
  );

  if (offline) {
    checks.push(check("axion_health", "skip", "offline"));
    checks.push(check("lexverdict_health", "skip", "offline"));
    checks.push(check("vekinbox_health", "skip", "offline"));
    checks.push(check("repo_freshness", "skip", "offline"));
  } else {
    if (!config?.adapters.axion.enabled) {
      checks.push(check("axion_health", "skip", "adapter not enabled"));
    } else {
      const url = `${config.adapters.axion.base_url.replace(/\/$/, "")}/api/health`;
      const res = await httpJson(url);
      const body = res.body as { ok?: unknown } | null;
      if (res.ok && body && body.ok === true) {
        checks.push(check("axion_health", "pass", url));
      } else {
        checks.push(check("axion_health", "fail", url));
      }
    }

    if (!config?.adapters.lexverdict.enabled) {
      checks.push(check("lexverdict_health", "skip", "adapter not enabled"));
    } else if (!process.env.LEXVERDICT_URL) {
      checks.push(check("lexverdict_health", "skip", "LEXVERDICT_URL unset"));
    } else {
      const base = process.env.LEXVERDICT_URL.replace(/\/$/, "");
      const url = `${base}/health`;
      const res = await httpJson(url);
      const body = res.body as { status?: unknown } | null;
      const status =
        body && typeof body.status === "string" ? body.status : undefined;
      if (res.ok && (status === "ok" || status === "degraded" || status === undefined)) {
        checks.push(check("lexverdict_health", "pass", status ?? `http ${res.status}`));
      } else {
        checks.push(check("lexverdict_health", "fail", url));
      }
    }

    if (!config?.adapters.vekinbox.enabled) {
      checks.push(check("vekinbox_health", "skip", "adapter not enabled"));
    } else if (!process.env.VEKINBOX_URL) {
      checks.push(check("vekinbox_health", "skip", "VEKINBOX_URL unset"));
    } else {
      let url = process.env.VEKINBOX_URL;
      try {
        url = `${new URL(process.env.VEKINBOX_URL).origin}/health`;
      } catch {
        url = process.env.VEKINBOX_URL;
      }
      const res = await httpJson(url);
      const body = res.body as { status?: unknown } | null;
      if (res.ok && body && body.status === "ok") {
        checks.push(check("vekinbox_health", "pass", url));
      } else {
        checks.push(check("vekinbox_health", "fail", url));
      }
    }

    const repos = config?.doctor.product_repos ?? [];
    if (repos.length === 0) {
      checks.push(check("repo_freshness", "skip", "no product_repos"));
    } else {
      let failed: string | undefined;
      let warned: string | undefined;
      for (const repo of repos) {
        const repoPath = path.resolve(cwd, repo.path);
        if (!existsSync(repoPath)) {
          failed = `${repo.slug} path missing`;
          break;
        }
        const head = await spawnCapture("git", ["-C", repoPath, "rev-parse", "HEAD"]);
        if (head.status !== 0) {
          failed = `${repo.slug} git rev-parse failed`;
          break;
        }
        const remote = await spawnCapture("git", [
          "-C",
          repoPath,
          "ls-remote",
          "origin",
          "HEAD",
        ]);
        const ahead = await spawnCapture("git", [
          "-C",
          repoPath,
          "rev-list",
          "--count",
          "origin/HEAD..HEAD",
        ]);
        const aheadCount = Number((ahead.stdout || "0").trim());
        if (ahead.status === 0 && aheadCount > 0) {
          warned = `${repo.slug} ahead_of_origin`;
          continue;
        }
        const log = await spawnCapture("git", [
          "-C",
          repoPath,
          "log",
          "-1",
          "--format=%ct",
        ]);
        const ts = Number((log.stdout || "0").trim());
        if (ts > 0) {
          const ageDays = (Date.now() / 1000 - ts) / 86400;
          const remoteHead = (remote.stdout || "").split(/\s+/)[0];
          const localHead = head.stdout.trim();
          if (remoteHead && remoteHead !== localHead && ageDays > repo.stale_days) {
            warned = `${repo.slug} stale`;
          }
        }
      }
      if (failed) {
        checks.push(check("repo_freshness", "fail", failed));
      } else if (warned) {
        checks.push(check("repo_freshness", "warn", warned));
      } else {
        checks.push(check("repo_freshness", "pass", `${repos.length} repos`));
      }
    }
  }

  if (!configPath || !existsSync(configPath)) {
    checks.push(check("secrets_not_in_config", "skip", "no config"));
  } else {
    try {
      const text = readFileSync(configPath, "utf8");
      const raw = parseJsonStrict(text, configPath);
      const hits = scanSecrets(raw);
      if (hits.length > 0) {
        checks.push(check("secrets_not_in_config", "fail", "secret pattern match"));
      } else {
        checks.push(check("secrets_not_in_config", "pass", "clean"));
      }
    } catch {
      checks.push(check("secrets_not_in_config", "skip", "unreadable"));
    }
  }

  if (
    !config?.adapters.axion.enabled ||
    !config.adapters.lexverdict.enabled
  ) {
    checks.push(
      check("port_collision_axion_lexverdict", "skip", "both adapters not enabled"),
    );
  } else if (!process.env.LEXVERDICT_URL) {
    checks.push(
      check("port_collision_axion_lexverdict", "skip", "LEXVERDICT_URL unset"),
    );
  } else {
    const axionHp = hostPort(config.adapters.axion.base_url);
    const lexHp = hostPort(process.env.LEXVERDICT_URL);
    if (axionHp === "127.0.0.1:8787" && lexHp === "127.0.0.1:8787") {
      checks.push(
        check(
          "port_collision_axion_lexverdict",
          "fail",
          "both resolve to 127.0.0.1:8787",
        ),
      );
    } else {
      checks.push(
        check(
          "port_collision_axion_lexverdict",
          "pass",
          `${axionHp} vs ${lexHp}`,
        ),
      );
    }
  }

  return { checks, fix_applied };
}

export async function runDoctor(raw: {
  offline?: boolean;
  fix?: boolean;
  json?: boolean;
}): Promise<void> {
  const json = raw.json === true;
  const result = await runDoctorChecks({
    offline: raw.offline === true,
    fix: raw.fix === true,
    cwd: process.cwd(),
  });
  const failed = result.checks.some((c) => c.status === "fail");
  if (json) {
    writeJson("doctor", !failed, result);
  } else {
    for (const c of result.checks) {
      process.stdout.write(`${formatDoctorLine(c)}\n`);
    }
  }
  process.exit(failed ? 1 : 0);
}

export function registerDoctor(program: Command): void {
  const cmd = program
    .command("doctor")
    .description("Check the local latticeag setup.")
    .option("--offline", "Skip git fetch and HTTP health")
    .option("--fix", "Create .latticeag/, pick ingest port, write missing .env.example")
    .action(async (opts: Record<string, unknown>, command: Command) => {
      const globals = readGlobalOpts(command);
      await runDoctor({
        offline: opts.offline === true,
        fix: opts.fix === true,
        json: globals.json === true,
      });
    });
  addGlobalOptions(cmd);
}

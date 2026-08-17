import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ZodIssue } from "zod";
import {
  latticeagConfigSchema,
  type LatticeagConfig,
} from "./schema.js";

export const CONFIG_FILENAME = "latticeag.json";

export interface LoadedConfig {
  config: LatticeagConfig;
  path: string;
  cwd: string;
  from_env: boolean;
}

export interface DiscoveredConfig {
  path: string;
  from_env: boolean;
}

export class ConfigNotFoundError extends Error {
  readonly code = "CONFIG_NOT_FOUND";
  constructor(readonly cwd: string) {
    super(`latticeag.json not found from ${cwd}`);
    this.name = "ConfigNotFoundError";
  }
}

export class ConfigParseError extends Error {
  readonly code = "CONFIG_PARSE";
  constructor(
    message: string,
    readonly filePath: string,
    readonly byteOffset: number,
  ) {
    super(message);
    this.name = "ConfigParseError";
  }
}

export class ConfigSchemaError extends Error {
  readonly code = "CONFIG_SCHEMA";
  constructor(
    message: string,
    readonly filePath: string,
    readonly issues: ZodIssue[],
  ) {
    super(message);
    this.name = "ConfigSchemaError";
  }
}

export function formatZodIssue(issue: ZodIssue): string {
  const loc = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${loc}: ${issue.message}`;
}

function envConfigPath(): string | undefined {
  const raw = process.env.LATTICEAG_CONFIG;
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function discoverConfig(cwd: string): DiscoveredConfig | null {
  const absCwd = path.resolve(cwd);
  const override = envConfigPath();
  if (override !== undefined) {
    return {
      path: path.isAbsolute(override) ? override : path.resolve(absCwd, override),
      from_env: true,
    };
  }
  let dir = absCwd;
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return { path: candidate, from_env: false };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function extractCharPosition(message: string): number | undefined {
  const match =
    message.match(/position\s+(\d+)/i) ??
    message.match(/at position (\d+)/i);
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
}

function classifyJsonError(text: string, charPos: number | undefined): string | undefined {
  const windowStart = charPos === undefined ? 0 : Math.max(0, charPos - 16);
  const windowEnd = charPos === undefined ? text.length : Math.min(text.length, charPos + 8);
  const around = text.slice(windowStart, windowEnd);
  if (/,\s*[}\]]/.test(around) || /,\s*$/.test(text.slice(0, charPos))) {
    return "trailing comma";
  }
  if (/\/\//.test(text) || /\/\*/.test(text)) {
    return "JSONC comments are not supported";
  }
  return undefined;
}

export function parseJsonStrict(text: string, filePath: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const charPos = extractCharPosition(message);
    const byteOffset =
      charPos === undefined
        ? 0
        : Buffer.byteLength(text.slice(0, charPos), "utf8");
    const kind = classifyJsonError(text, charPos);
    const suffix = kind ? ` (${kind})` : "";
    throw new ConfigParseError(
      `${filePath}: invalid JSON at byte offset ${byteOffset}${suffix}: ${message}`,
      filePath,
      byteOffset,
    );
  }
}

export function readConfigFile(filePath: string): LatticeagConfig {
  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigNotFoundError(path.dirname(filePath));
    }
    throw err;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ConfigParseError(
      `${filePath}: invalid JSON at byte offset 0: file is not valid UTF-8`,
      filePath,
      0,
    );
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  const raw = parseJsonStrict(text, filePath);
  const parsed = latticeagConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const summary = first ? formatZodIssue(first) : "invalid config";
    throw new ConfigSchemaError(
      `${filePath}: ${summary}`,
      filePath,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export function loadConfig(cwd: string): LoadedConfig {
  const absCwd = path.resolve(cwd);
  const discovered = discoverConfig(absCwd);
  if (!discovered) {
    throw new ConfigNotFoundError(absCwd);
  }
  const config = readConfigFile(discovered.path);
  return {
    config,
    path: discovered.path,
    cwd: absCwd,
    from_env: discovered.from_env,
  };
}

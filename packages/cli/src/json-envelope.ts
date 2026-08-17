import { CLI_VERSION } from "./cli-version.js";

export interface CommandJson<T> {
  ok: boolean;
  command: string;
  cli_version: string;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

export function writeJson<T>(
  command: string,
  ok: boolean,
  data: T,
  error?: CommandJson<T>["error"],
): void {
  const envelope: CommandJson<T> = {
    ok,
    command,
    cli_version: CLI_VERSION,
    data,
  };
  if (error) {
    envelope.error = error;
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

export function fail(
  message: string,
  options: {
    json?: boolean;
    command?: string;
    code?: string;
    details?: unknown;
    exitCode?: number;
  } = {},
): never {
  const command = options.command ?? "latticeag";
  if (options.json) {
    writeJson(command, false, null, {
      code: options.code ?? "ERROR",
      message,
      details: options.details,
    });
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(options.exitCode ?? 1);
}

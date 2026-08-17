import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigSchemaError,
} from "@latticeag/config";
import { fail } from "./json-envelope.js";

export function failConfig(
  err: unknown,
  json: boolean,
  command: string,
): never {
  if (
    err instanceof ConfigNotFoundError ||
    err instanceof ConfigParseError ||
    err instanceof ConfigSchemaError
  ) {
    fail(err.message, { json, command, code: err.code, exitCode: 1 });
  }
  throw err;
}

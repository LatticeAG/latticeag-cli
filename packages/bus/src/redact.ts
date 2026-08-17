import { DEFAULT_REDACT_KEYS } from "@latticeag/events";
import type { RedactionStamp } from "@latticeag/events";

export const REDACTED = "[REDACTED]";

export function mergeRedactKeys(extra: readonly string[]): Set<string> {
  return new Set<string>([...DEFAULT_REDACT_KEYS, ...extra]);
}

export interface RedactResult<T> {
  value: T;
  stamp: RedactionStamp;
}

function shouldRedactKey(
  key: string,
  keys: ReadonlySet<string>,
  includeRawText: boolean,
): boolean {
  if (key === "rawText" && includeRawText) {
    return false;
  }
  return keys.has(key);
}

function redactUnknown(
  value: unknown,
  keys: ReadonlySet<string>,
  includeRawText: boolean,
  hits: string[],
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, keys, includeRawText, hits));
  }
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(input)) {
    if (shouldRedactKey(key, keys, includeRawText)) {
      out[key] = REDACTED;
      hits.push(key);
    } else {
      out[key] = redactUnknown(nested, keys, includeRawText, hits);
    }
  }
  return out;
}

export function redactDeep<T>(
  value: T,
  keys: ReadonlySet<string>,
  includeRawText: boolean,
): RedactResult<T> {
  const hits: string[] = [];
  const redacted = redactUnknown(value, keys, includeRawText, hits) as T;
  const unique = [...new Set(hits)];
  return {
    value: redacted,
    stamp: {
      applied: hits.length > 0,
      keys: unique,
      pattern_hits: hits.length,
    },
  };
}

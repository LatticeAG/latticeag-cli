/**
 * Redaction helpers for axion belief data: strips configured keys and
 * rawText before payloads leave the process.
 */
export interface RedactWalkResult {
  value: unknown;
  pattern_hits: number;
  keys_hit: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function redactValue(
  value: unknown,
  keys: readonly string[],
  include_raw_text: boolean,
): RedactWalkResult {
  const keySet = new Set(keys);
  const keys_hit: string[] = [];
  let pattern_hits = 0;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map((item) => walk(item));
    }
    if (!isRecord(node)) {
      return node;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "rawText" && !include_raw_text) {
        pattern_hits += 1;
        if (!keys_hit.includes(key)) {
          keys_hit.push(key);
        }
        continue;
      }
      if (keySet.has(key)) {
        pattern_hits += 1;
        if (!keys_hit.includes(key)) {
          keys_hit.push(key);
        }
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = walk(child);
    }
    return out;
  };

  return { value: walk(value), pattern_hits, keys_hit };
}

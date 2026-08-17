import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { JsonObject, VerdictEvent } from "@latticeag/events";
import { LatticeAGError, StageTimeoutError } from "../errors.js";
import {
  fromVerdictResponse,
  sha256Utf8Hex,
  toVerifyBody,
} from "../integration/mappers.js";
import { redactValue } from "../integration/redact.js";
import type { VerifyInput } from "../types.js";
import type { StageExecuteContext } from "./types.js";

export const MAX_VERIFICATION_FIELD_CHARS = 8000;

export const verifyInputSchema: z.ZodType<VerifyInput> = z
  .object({
    causation_id: z.string().min(1).optional(),
    tool_call: z.string().optional(),
    name: z.string().optional(),
    arguments: z.record(z.string(), z.any()).optional() as z.ZodType<JsonObject | undefined>,
    result: z.any().optional(),
    error: z.string().optional(),
    goal: z.string().optional(),
    force: z.boolean().optional(),
  })
  .strict();

const LEX_PRODUCER = {
  product: "lexverdict" as const,
  adapter: "@latticeag/adapter-lexverdict",
  adapter_version: "0.1.0",
};

interface FixtureVerdict {
  tool_name?: string;
  causation_id?: string;
  verdict: "pass" | "steer";
  confidence: number;
  message: string | null;
  used?: boolean;
}

export async function executeVerify(
  input: VerifyInput,
  ctx: StageExecuteContext,
  seen: Map<string, VerdictEvent>,
  unusedFixtures: { rows: FixtureVerdict[] },
): Promise<VerdictEvent> {
  const parsed = verifyInputSchema.parse(input);
  if (parsed.causation_id && parsed.force !== true) {
    const existing = seen.get(parsed.causation_id);
    if (existing) {
      return existing;
    }
  }

  const tool_call =
    parsed.tool_call ??
    `${parsed.name ?? ""} ${JSON.stringify(parsed.arguments ?? {})}`.trim();
  const result = JSON.stringify(parsed.result ?? parsed.error ?? "");
  const goal = parsed.goal ?? ctx.env.LATTICEAG_GOAL ?? "complete the user task";

  for (const [field, value] of [
    ["tool_call", tool_call],
    ["goal", goal],
    ["result", result],
  ] as const) {
    if (value.length === 0 || value.length > MAX_VERIFICATION_FIELD_CHARS) {
      throw new LatticeAGError(
        "VERIFY_FIELD_TOO_LONG",
        `${field} must be non-empty and <= ${MAX_VERIFICATION_FIELD_CHARS} chars`,
      );
    }
  }

  const walked = redactValue(
    { tool_call, goal, result },
    ctx.config.redaction.keys,
    ctx.config.redaction.include_raw_text,
  );
  const posted = walked.value as { tool_call: string; goal: string; result: string };
  const hashes = {
    tool_call_sha256: sha256Utf8Hex(posted.tool_call),
    goal_sha256: sha256Utf8Hex(posted.goal),
    result_sha256: sha256Utf8Hex(posted.result),
  };

  let payload;
  if (ctx.backend.kind === "fixture") {
    const row = matchFixture(unusedFixtures.rows, parsed);
    payload = fromVerdictResponse(
      { verdict: row.verdict, confidence: row.confidence, message: row.message },
      posted,
      hashes,
      0,
    );
  } else {
    const base = ctx.env.LEXVERDICT_URL;
    if (!base) {
      throw new LatticeAGError("STAGE_BACKEND", "LEXVERDICT_URL unset");
    }
    const url = `${base.replace(/\/$/, "")}/v1/verify`;
    const timeout = ctx.config.adapters.lexverdict.timeout_ms;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const started = Date.now();
    let body: { verdict: "pass" | "steer"; confidence: number; message: string | null };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toVerifyBody(posted)),
        signal: ctx.abort.aborted ? ctx.abort : controller.signal,
      });
      if (!res.ok) {
        throw new LatticeAGError("STAGE_BACKEND", `lexverdict ${res.status}`);
      }
      body = (await res.json()) as typeof body;
    } catch (err) {
      if (err instanceof LatticeAGError) {
        throw err;
      }
      throw new StageTimeoutError("STAGE_TIMEOUT", `lexverdict verify failed`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
    payload = fromVerdictResponse(body, posted, hashes, Date.now() - started);
  }

  const event = (await ctx.bus.emit({
    name: "verdict",
    payload,
    producer: LEX_PRODUCER,
    correlation_id: ctx.run_id,
    ...(parsed.causation_id !== undefined ? { causation_id: parsed.causation_id } : {}),
  })) as VerdictEvent;

  if (parsed.causation_id) {
    seen.set(parsed.causation_id, event);
  }
  return event;
}

export async function loadVerdictFixtures(path: string): Promise<FixtureVerdict[]> {
  const raw = JSON.parse(await readFile(path, "utf8")) as FixtureVerdict[];
  return raw.map((row) => ({ ...row, used: false }));
}

function matchFixture(rows: FixtureVerdict[], input: VerifyInput): FixtureVerdict {
  const byCause = rows.find((row) => !row.used && row.causation_id && row.causation_id === input.causation_id);
  if (byCause) {
    byCause.used = true;
    return byCause;
  }
  const byName = rows.find((row) => !row.used && row.tool_name && row.tool_name === input.name);
  if (byName) {
    byName.used = true;
    return byName;
  }
  const first = rows.find((row) => !row.used);
  if (!first) {
    throw new LatticeAGError("STAGE_BACKEND", "no unused fixture verdict rows");
  }
  first.used = true;
  return first;
}

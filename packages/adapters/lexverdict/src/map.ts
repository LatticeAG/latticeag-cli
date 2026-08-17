/**
 * LexVerdict mapping helpers: hash, verify request body, verdict response.
 */
import { createHash } from "node:crypto";
import type { VerdictPayload } from "@latticeag/events";

export function sha256Utf8Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256BytesHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function toVerifyBody(input: {
  tool_call: string;
  goal: string;
  result: string;
}): { tool_call: string; goal: string; result: string } {
  return {
    tool_call: input.tool_call,
    goal: input.goal,
    result: input.result,
  };
}

export function fromVerdictResponse(
  body: { verdict: "pass" | "steer"; confidence: number; message: string | null },
  posted: { tool_call: string; goal: string; result: string },
  hashes: { tool_call_sha256: string; goal_sha256: string; result_sha256: string },
  latency_ms: number,
): VerdictPayload {
  return {
    verdict: body.verdict,
    confidence: body.confidence,
    message: body.message,
    tool_call: posted.tool_call,
    goal: posted.goal,
    result: posted.result,
    tool_call_sha256: hashes.tool_call_sha256,
    goal_sha256: hashes.goal_sha256,
    result_sha256: hashes.result_sha256,
    latency_ms,
  };
}

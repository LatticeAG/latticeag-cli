import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REDACT_KEYS } from "@latticeag/events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { IngestBus } from "./child-bus.js";
import { LatticeAGError } from "./errors.js";

const eventsFixtures = join(dirname(fileURLToPath(import.meta.url)), "../../events/fixtures");

const PRODUCER = {
  product: "axion" as const,
  adapter: "@latticeag/adapter-axion",
  adapter_version: "0.1.0",
};

function ackEvent(): unknown {
  return JSON.parse(readFileSync(join(eventsFixtures, "tool_observed.json"), "utf8")) as unknown;
}

describe("IngestBus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("POST body has no id/seq and url ends with /generic", async () => {
    let posted: Record<string, unknown> | undefined;
    let postedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        postedUrl = String(input);
        posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify(ackEvent()), { status: 202 });
      }),
    );
    const bus = new IngestBus({
      ingest_url: "http://127.0.0.1:9847/v1/ingest",
      run_id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      session_id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      redact_keys: [...DEFAULT_REDACT_KEYS],
      include_raw_text: false,
    });
    await bus.emit({
      name: "tool_observed",
      payload: { source: "visreplay", name: "write_file", arguments: { path: "a" } },
      producer: PRODUCER,
      correlation_id: bus.run_id,
    });
    expect(postedUrl.endsWith("/generic")).toBe(true);
    expect(posted).toBeDefined();
    expect(posted).not.toHaveProperty("id");
    expect(posted).not.toHaveProperty("seq");
    await bus.close();
  });

  test("redact before POST: secret apiKey not in body", async () => {
    let postedBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        postedBody = String(init?.body);
        return new Response(JSON.stringify(ackEvent()), { status: 202 });
      }),
    );
    const bus = new IngestBus({
      ingest_url: "http://127.0.0.1:9847/v1/ingest",
      run_id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      session_id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      redact_keys: [...DEFAULT_REDACT_KEYS],
      include_raw_text: false,
    });
    await bus.emit({
      name: "tool_observed",
      payload: {
        source: "visreplay",
        name: "write_file",
        arguments: { apiKey: "sk-secret", path: "a" },
      },
      producer: PRODUCER,
      correlation_id: bus.run_id,
    });
    expect(postedBody).not.toContain("sk-secret");
    const parsed = JSON.parse(postedBody) as {
      payload: { arguments: Record<string, unknown> };
    };
    expect(parsed.payload.arguments.apiKey).toBe("[REDACTED]");
    await bus.close();
  });

  test("fetch 500 throws LatticeAGError INGEST_HTTP_500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const bus = new IngestBus({
      ingest_url: "http://127.0.0.1:9847/v1/ingest",
      run_id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      session_id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      redact_keys: [...DEFAULT_REDACT_KEYS],
      include_raw_text: false,
    });
    try {
      await bus.emit({
        name: "tool_observed",
        payload: { source: "visreplay", name: "write_file", arguments: {} },
        producer: PRODUCER,
        correlation_id: bus.run_id,
      });
      expect.fail("expected ingest 500");
    } catch (err) {
      expect(err).toBeInstanceOf(LatticeAGError);
      expect((err as LatticeAGError).code).toBe("INGEST_HTTP_500");
    }
    await bus.close();
  });
});

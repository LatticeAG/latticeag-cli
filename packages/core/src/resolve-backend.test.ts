import { join } from "node:path";
import { loadConfig } from "@latticeag/config";
import { describe, expect, test } from "vitest";
import { BackendUnresolvedError } from "./errors.js";
import { overlayCreateOptions } from "./overlay.js";
import { resolveBackend, type ResolveBackendContext } from "./resolve-backend.js";
import { FIXTURES, cleanEnv } from "./test-harness.js";
import type { StageId } from "./types.js";

function ctx(partial: Partial<ResolveBackendContext> = {}): ResolveBackendContext {
  const loaded = loadConfig(FIXTURES);
  return {
    cwd: FIXTURES,
    env: cleanEnv(),
    config: loaded.config,
    overlay: overlayCreateOptions({}, {}),
    registered: new Set<StageId>(),
    fetchImpl: async () => {
      throw new Error("network disabled");
    },
    cache: new Map(),
    ...partial,
  };
}

describe("resolveBackend", () => {
  test("fixture wins when beliefs path exists and no explicit backend", async () => {
    const resolved = await resolveBackend(
      "inspect",
      ctx({
        overlay: overlayCreateOptions(
          { fixtures: { beliefs: join(FIXTURES, "beliefs.json") } },
          {},
        ),
      }),
    );
    expect(resolved.kind).toBe("fixture");
    expect(resolved.stage).toBe("inspect");
  });

  test("record proxy throws BackendUnresolvedError visreplay is local-only", async () => {
    try {
      await resolveBackend(
        "record",
        ctx({
          overlay: overlayCreateOptions({ stages: { record: { backend: "proxy" } } }, {}),
        }),
      );
      expect.fail("expected BackendUnresolvedError");
    } catch (err) {
      expect(err).toBeInstanceOf(BackendUnresolvedError);
      const probes = (err as BackendUnresolvedError).probes;
      expect(probes[0]?.detail).toMatch(/visreplay is local-only/);
    }
  });

  test("local health 200: inspect resolves local when no fixture path", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/health")) {
        return new Response("ok", { status: 200 });
      }
      return new Response("missing", { status: 404 });
    };
    const resolved = await resolveBackend(
      "inspect",
      ctx({
        overlay: overlayCreateOptions({}, {}),
        fetchImpl,
      }),
    );
    expect(resolved.kind).toBe("local");
    expect(resolved.stage).toBe("inspect");
  });

  test("all fail probe log length 3", async () => {
    try {
      await resolveBackend(
        "inspect",
        ctx({
          overlay: overlayCreateOptions({}, {}),
          fetchImpl: async () => {
            throw new Error("always fail");
          },
        }),
      );
      expect.fail("expected BackendUnresolvedError");
    } catch (err) {
      expect(err).toBeInstanceOf(BackendUnresolvedError);
      const probes = (err as BackendUnresolvedError).probes;
      expect(probes).toHaveLength(3);
      expect(probes.map((p) => p.kind)).toEqual(["local", "proxy", "hosted"]);
    }
  });
});

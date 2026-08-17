import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IngestBindError, startIngest, type IngestServer } from "./ingest.js";

const servers: IngestServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe("ingest", () => {
  it("GET /v1/ingest/health returns 200 { ok: true }", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "latticeag-ingest-"));
    const server = await startIngest({
      bind: "127.0.0.1",
      port: 0,
      cwd,
    });
    servers.push(server);
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects bind 0.0.0.0 unless LATTICEAG_INGEST_EXPOSE=1", async () => {
    await expect(
      startIngest({
        bind: "0.0.0.0",
        port: 0,
        env: {},
        cwd: mkdtempSync(join(tmpdir(), "latticeag-ingest-")),
      }),
    ).rejects.toBeInstanceOf(IngestBindError);
    await expect(
      startIngest({
        bind: "0.0.0.0",
        port: 0,
        env: { LATTICEAG_INGEST_EXPOSE: "0" },
        cwd: mkdtempSync(join(tmpdir(), "latticeag-ingest-")),
      }),
    ).rejects.toThrow(/0\.0\.0\.0/);
  });
});

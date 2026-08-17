import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { LatticeAGError } from "../errors.js";
import { createFixtureLattice } from "../test-harness.js";
import { createLangGraphCallback } from "./langgraph.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("createLangGraphCallback", () => {
  test("start/end pairing emits tool_observed source visreplay", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      const cb = createLangGraphCallback(lattice);
      cb.handleToolStart({ name: "write_file", runId: "run-1", inputs: { path: "a" } });
      const event = await cb.handleToolEnd({ runId: "run-1", output: { ok: true } });
      expect(event.name).toBe("tool_observed");
      expect(event.payload.source).toBe("visreplay");
      expect(event.payload.name).toBe("write_file");
    } finally {
      await lattice.close();
    }
  });

  test("unmatched tool end throws LANGGRAPH_TOOL_UNMATCHED", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      const cb = createLangGraphCallback(lattice);
      await expect(cb.handleToolEnd({ runId: "missing", output: "x" })).rejects.toMatchObject({
        code: "LANGGRAPH_TOOL_UNMATCHED",
      });
      try {
        await cb.handleToolEnd({ runId: "missing", output: "x" });
        expect.fail("expected LANGGRAPH_TOOL_UNMATCHED");
      } catch (err) {
        expect(err).toBeInstanceOf(LatticeAGError);
        expect((err as LatticeAGError).code).toBe("LANGGRAPH_TOOL_UNMATCHED");
      }
    } finally {
      await lattice.close();
    }
  });

  test("inspectOnLlmEnd false: handleLLMEnd does not throw without extract module", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      const cb = createLangGraphCallback(lattice, { inspectOnLlmEnd: false });
      await expect(cb.handleLLMEnd?.({ text: "hello" })).resolves.toBeUndefined();
    } finally {
      await lattice.close();
    }
  });

  test("langgraph_callback.py sha256 matches langgraph_callback.sha256", () => {
    const py = readFileSync(join(here, "langgraph_callback.py"));
    const expected = readFileSync(join(here, "langgraph_callback.sha256"), "utf8").trim();
    expect(createHash("sha256").update(py).digest("hex")).toBe(expected);
  });
});

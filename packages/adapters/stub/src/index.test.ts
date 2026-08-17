import { describe, expect, it } from "vitest";
import { createAdapter } from "./index.js";

describe("adapter-stub", () => {
  it("start is a noop and health is ok with detail stub", async () => {
    const adapter = createAdapter();
    expect(adapter.id).toBe("stub");
    await adapter.start({} as never);
    const health = await adapter.health();
    expect(health).toEqual({ id: "stub", ok: true, detail: "stub" });
    await adapter.stop();
    await adapter.stop();
  });
});

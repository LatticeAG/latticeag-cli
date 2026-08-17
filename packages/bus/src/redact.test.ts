import { describe, expect, it } from "vitest";
import { REDACTED, mergeRedactKeys, redactDeep } from "./redact.js";

describe("redact", () => {
  it("redact rawText to [REDACTED]", () => {
    const keys = mergeRedactKeys([]);
    const result = redactDeep(
      { rawText: "user said a secret", keep: "ok" },
      keys,
      false,
    );
    expect(result.value).toEqual({ rawText: REDACTED, keep: "ok" });
    expect(result.stamp.pattern_hits).toBe(1);
    expect(result.stamp.keys).toContain("rawText");
  });

  it("include_raw_text keeps it", () => {
    const keys = mergeRedactKeys([]);
    const result = redactDeep(
      { rawText: "user said a secret", token: "abc" },
      keys,
      true,
    );
    expect(result.value).toEqual({ rawText: "user said a secret", token: REDACTED });
    expect(result.stamp.keys).not.toContain("rawText");
    expect(result.stamp.keys).toContain("token");
  });

  it("nested apiKey/token", () => {
    const keys = mergeRedactKeys([]);
    const result = redactDeep(
      {
        nested: {
          apiKey: "k-live",
          token: "t-live",
          ok: 1,
        },
        list: [{ apiKey: "k2" }, { token: "t2" }],
      },
      keys,
      false,
    );
    expect(result.value).toEqual({
      nested: { apiKey: REDACTED, token: REDACTED, ok: 1 },
      list: [{ apiKey: REDACTED }, { token: REDACTED }],
    });
    expect(result.stamp.pattern_hits).toBe(4);
  });
});

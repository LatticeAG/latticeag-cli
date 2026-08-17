import { describe, expect, test } from "vitest";
import { PlatformError } from "./errors.js";
import { assertNotWindows } from "./platform.js";

describe("assertNotWindows", () => {
  test("win32 throws PlatformError with code PLATFORM_WINDOWS", () => {
    expect(() => assertNotWindows("win32")).toThrow(PlatformError);
    try {
      assertNotWindows("win32");
    } catch (err) {
      expect(err).toBeInstanceOf(PlatformError);
      expect((err as PlatformError).code).toBe("PLATFORM_WINDOWS");
    }
  });

  test("linux does not throw", () => {
    expect(() => assertNotWindows("linux")).not.toThrow();
  });
});

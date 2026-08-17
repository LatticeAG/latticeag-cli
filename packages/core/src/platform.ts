import { PlatformError } from "./errors.js";

export function assertNotWindows(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new PlatformError("PLATFORM_WINDOWS", "Windows is unsupported in v0.1. Use WSL.");
  }
}

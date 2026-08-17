import path from "node:path";
import type { AgentAttachKit } from "./types.js";
import { injectAxionBaseUrls } from "./types.js";

export const hermesKit: AgentAttachKit = {
  id: "hermes",
  detect(env, argv) {
    if (typeof env.HERMES_HOME === "string" && env.HERMES_HOME.length > 0) {
      return true;
    }
    const bin = argv[0];
    if (!bin) {
      return false;
    }
    const base = path.basename(bin).replace(/\.exe$/i, "");
    return base === "hermes";
  },
  injectEnv(env, ctx) {
    return injectAxionBaseUrls(env, ctx);
  },
};

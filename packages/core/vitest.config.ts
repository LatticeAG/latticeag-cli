import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@latticeag/events": fileURLToPath(
        new URL("../events/src/index.ts", import.meta.url),
      ),
      "@latticeag/bus": fileURLToPath(
        new URL("../bus/src/index.ts", import.meta.url),
      ),
      "@latticeag/config": fileURLToPath(
        new URL("../config/src/index.ts", import.meta.url),
      ),
      "@latticeag/adapter-axion/redact": fileURLToPath(
        new URL("../adapters/axion/src/redact.ts", import.meta.url),
      ),
      "@latticeag/adapter-axion/map": fileURLToPath(
        new URL("../adapters/axion/src/map.ts", import.meta.url),
      ),
      "@latticeag/adapter-lexverdict/map": fileURLToPath(
        new URL("../adapters/lexverdict/src/map.ts", import.meta.url),
      ),
      "@latticeag/adapter-vekinbox/map": fileURLToPath(
        new URL("../adapters/vekinbox/src/map.ts", import.meta.url),
      ),
      "@latticeag/adapter-visreplay/map": fileURLToPath(
        new URL("../adapters/visreplay/src/map.ts", import.meta.url),
      ),
    },
  },
});

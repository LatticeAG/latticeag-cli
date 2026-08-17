import { zodToJsonSchema } from "zod-to-json-schema";
import { LATTICEAG_CONFIG_SCHEMA_URL, latticeagConfigSchema } from "./schema.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

export function latticeagConfigJsonSchema(): Record<string, unknown> {
  const generated = zodToJsonSchema(latticeagConfigSchema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  const rest = { ...generated };
  delete rest.$schema;
  return {
    $schema: DRAFT_2020_12,
    $id: LATTICEAG_CONFIG_SCHEMA_URL,
    ...rest,
  };
}

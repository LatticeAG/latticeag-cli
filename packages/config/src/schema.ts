import { z } from "zod";

export const LATTICEAG_CONFIG_SCHEMA_URL =
  "https://latticeag.dev/schemas/latticeag-config/v1.json";

export const DEFAULT_REDACTION_KEYS = [
  "authorization",
  "Authorization",
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "rawText",
] as const;

export const adapterNameSchema = z.enum([
  "axion",
  "visreplay",
  "lexverdict",
  "vekinbox",
  "viscompile",
  "lexshield",
  "polymesh",
]);

export type AdapterName = z.infer<typeof adapterNameSchema>;

export const ADAPTER_NAMES = adapterNameSchema.options;

export const DEFAULT_ADAPTER_SLUGS: AdapterName[] = [
  "axion",
  "visreplay",
  "lexverdict",
  "vekinbox",
];

export const DEFAULT_ADAPTERS_LIST = DEFAULT_ADAPTER_SLUGS.join(",");

export const latticeagConfigSchema = z
  .object({
    $schema: z.string().url().optional(),
    schema_version: z.literal(1),
    project: z
      .object({
        name: z.string().min(1).max(128),
        run_id_prefix: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,15}$/)
          .default("run"),
      })
      .strict(),
    bus: z
      .object({
        log_path: z.string().min(1).default(".latticeag/events.jsonl"),
        ring_capacity: z.number().int().min(100).max(1000000).default(10000),
        overflow_block_ms: z.number().int().min(0).max(60000).default(5000),
        overflow: z.enum(["block_then_drop", "drop"]).default("block_then_drop"),
        max_log_bytes: z
          .number()
          .int()
          .min(1048576)
          .max(4294967296)
          .default(268435456),
        persist_fail: z.enum(["throw", "log"]).default("throw"),
      })
      .strict(),
    ingest: z
      .object({
        bind: z.literal("127.0.0.1"),
        port: z.number().int().min(1024).max(65535).default(9847),
        path: z.literal("/v1/ingest"),
      })
      .strict(),
    adapters: z
      .object({
        axion: z
          .object({
            enabled: z.boolean(),
            mode: z.enum(["webhook", "poll"]).default("webhook"),
            base_url: z.string().url(),
            webhook_path: z.literal("/v1/ingest/axion"),
            poll_interval_ms: z.number().int().min(200).max(10000).default(1000),
          })
          .strict(),
        visreplay: z
          .object({
            enabled: z.boolean(),
            session_dir: z.string().min(1),
            agent_type: z.string().min(1).default("custom"),
          })
          .strict(),
        lexverdict: z
          .object({
            enabled: z.boolean(),
            base_url_env: z.literal("LEXVERDICT_URL"),
            timeout_ms: z.number().int().min(1000).max(60000).default(15000),
          })
          .strict(),
        vekinbox: z
          .object({
            enabled: z.boolean(),
            base_url_env: z.literal("VEKINBOX_URL"),
            api_key_env: z.literal("VEKINBOX_API_KEY"),
            workspace_id_env: z.literal("VEKINBOX_WORKSPACE_ID"),
            agent_id_env: z.literal("VEKINBOX_AGENT_ID"),
            timeout: z
              .string()
              .regex(/^\d+[smhd]$/)
              .default("1h"),
          })
          .strict(),
        viscompile: z
          .object({
            enabled: z.boolean(),
            bin: z.literal("lattice"),
            schema_version: z.union([z.literal(1), z.literal(2)]).default(2),
            baseline: z.string().min(1),
            fail_on_regression: z.boolean().default(false),
          })
          .strict(),
        lexshield: z
          .object({
            enabled: z.boolean(),
            bin: z.literal("lexshield"),
            pack: z.string().min(1).default("baseline-deny"),
          })
          .strict(),
        polymesh: z
          .object({
            enabled: z.boolean(),
            gateway_url_env: z.literal("POLYMESH_GATEWAY_URL"),
            mesh_id_env: z.literal("POLYMESH_MESH_ID"),
            capability: z.literal("latticeag.events.relay"),
          })
          .strict(),
      })
      .strict(),
    redaction: z
      .object({
        keys: z.array(z.string().min(1)).min(1),
        include_raw_text: z.boolean().default(false),
      })
      .strict(),
    sync: z
      .object({
        enabled: z.boolean(),
        gateway_url_env: z.literal("LEXGATEWAY_URL"),
        token_env: z.literal("LEXGATEWAY_TOKEN"),
        mode: z.enum(["replicate", "fanout"]).default("replicate"),
        local_port: z.number().int().min(1024).max(65535).default(8788),
        polymesh: z
          .object({
            enabled: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    doctor: z
      .object({
        product_repos: z
          .array(
            z
              .object({
                slug: z.string(),
                path: z.string(),
                stale_days: z.number().int().min(1).max(365).default(30),
              })
              .strict(),
          )
          .default([]),
      })
      .strict(),
  })
  .strict();

export type LatticeagConfig = z.infer<typeof latticeagConfigSchema>;

export class UnknownAdapterError extends Error {
  constructor(readonly slug: string) {
    super(`unknown adapter slug: ${slug}`);
    this.name = "UnknownAdapterError";
  }
}

export function parseAdapterList(list: string): AdapterName[] {
  const parts = list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: AdapterName[] = [];
  for (const part of parts) {
    const parsed = adapterNameSchema.safeParse(part);
    if (!parsed.success) {
      throw new UnknownAdapterError(part);
    }
    if (!out.includes(parsed.data)) {
      out.push(parsed.data);
    }
  }
  return out;
}

export function enabledAdapters(config: LatticeagConfig): AdapterName[] {
  return ADAPTER_NAMES.filter((name) => config.adapters[name].enabled);
}

export function createDefaultConfig(
  projectName: string,
  enabled: AdapterName[],
): LatticeagConfig {
  const set = new Set(enabled);
  return latticeagConfigSchema.parse({
    $schema: LATTICEAG_CONFIG_SCHEMA_URL,
    schema_version: 1,
    project: { name: projectName },
    bus: {},
    ingest: { bind: "127.0.0.1", path: "/v1/ingest" },
    adapters: {
      axion: {
        enabled: set.has("axion"),
        base_url: "http://127.0.0.1:8787",
        webhook_path: "/v1/ingest/axion",
      },
      visreplay: {
        enabled: set.has("visreplay"),
        session_dir: ".latticeag/sessions",
      },
      lexverdict: {
        enabled: set.has("lexverdict"),
        base_url_env: "LEXVERDICT_URL",
      },
      vekinbox: {
        enabled: set.has("vekinbox"),
        base_url_env: "VEKINBOX_URL",
        api_key_env: "VEKINBOX_API_KEY",
        workspace_id_env: "VEKINBOX_WORKSPACE_ID",
        agent_id_env: "VEKINBOX_AGENT_ID",
      },
      viscompile: {
        enabled: set.has("viscompile"),
        bin: "lattice",
        baseline: "fixtures/baseline.snapshot.json",
      },
      lexshield: {
        enabled: set.has("lexshield"),
        bin: "lexshield",
      },
      polymesh: {
        enabled: set.has("polymesh"),
        gateway_url_env: "POLYMESH_GATEWAY_URL",
        mesh_id_env: "POLYMESH_MESH_ID",
        capability: "latticeag.events.relay",
      },
    },
    redaction: {
      keys: [...DEFAULT_REDACTION_KEYS],
    },
    sync: {
      enabled: false,
      gateway_url_env: "LEXGATEWAY_URL",
      token_env: "LEXGATEWAY_TOKEN",
      polymesh: { enabled: false },
    },
    doctor: {},
  });
}

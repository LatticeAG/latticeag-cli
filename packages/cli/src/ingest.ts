import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import type { LatticeBus } from "@latticeag/bus";
import type { LatticeagConfig } from "@latticeag/config";
import {
  EVENT_NAMES,
  type EventName,
  type PayloadMap,
  type Producer,
} from "@latticeag/events";

export const DEFAULT_INGEST_BIND = "127.0.0.1";
export const DEFAULT_INGEST_PORT = 9847;
export const DEFAULT_INGEST_PATH = "/v1/ingest";

export type IngestHandler = (
  req: IncomingMessage & { rawBody?: Buffer },
  res: ServerResponse,
  body: unknown,
) => Promise<void> | void;

export interface StartIngestOptions {
  bind?: string;
  port?: number;
  path?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  config?: LatticeagConfig;
  bus?: LatticeBus;
  producer?: Producer;
}

export interface IngestServer {
  url: string;
  bind: string;
  port: number;
  registerIngest(path: string, handler: IngestHandler): void;
  close(): Promise<void>;
}

const INTERNAL_PRODUCER: Producer = {
  product: "latticeag",
  adapter: "latticeag-internal",
  adapter_version: "0.1.0",
};

const EVENT_NAME_SET = new Set<string>(EVENT_NAMES);

export class IngestBindError extends Error {
  readonly code = "INGEST_BIND";
  constructor(message: string) {
    super(message);
    this.name = "IngestBindError";
  }
}

export function ingestPidPath(cwd: string): string {
  return path.join(cwd, ".latticeag", "ingest.pid");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function normalizeRoute(ingestPath: string, registered: string): string {
  if (registered.startsWith(ingestPath)) {
    return registered;
  }
  const suffix = registered.startsWith("/") ? registered : `/${registered}`;
  return `${ingestPath}${suffix}`;
}

function isEventName(name: string): name is EventName {
  return EVENT_NAME_SET.has(name);
}

export async function startIngest(
  opts: StartIngestOptions = {},
): Promise<IngestServer> {
  const env = opts.env ?? process.env;
  const bind =
    opts.bind ?? opts.config?.ingest.bind ?? DEFAULT_INGEST_BIND;
  const requestedPort =
    opts.port ?? opts.config?.ingest.port ?? DEFAULT_INGEST_PORT;
  const ingestPath = opts.path ?? opts.config?.ingest.path ?? DEFAULT_INGEST_PATH;
  const cwd = opts.cwd ?? process.cwd();

  if (bind === "0.0.0.0" && env.LATTICEAG_INGEST_EXPOSE !== "1") {
    throw new IngestBindError(
      "ingest bind 0.0.0.0 refused unless LATTICEAG_INGEST_EXPOSE=1",
    );
  }

  const handlers = new Map<string, IngestHandler>();

  const registerIngest = (route: string, handler: IngestHandler): void => {
    handlers.set(normalizeRoute(ingestPath, route), handler);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      if (req.method === "GET" && url === `${ingestPath}/health`) {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      const raw = await readRaw(req);
      (req as IncomingMessage & { rawBody?: Buffer }).rawBody = raw;
      let body: unknown = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString("utf8")) as unknown;
        } catch {
          json(res, 400, { ok: false, error: "invalid json" });
          return;
        }
      }
      if (url === `${ingestPath}/generic`) {
        if (!opts.bus) {
          json(res, 503, { ok: false, error: "bus not attached" });
          return;
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          json(res, 400, { ok: false, error: "expected object body" });
          return;
        }
        const rec = body as Record<string, unknown>;
        if (typeof rec.name !== "string" || !isEventName(rec.name)) {
          json(res, 400, { ok: false, error: "unknown event name" });
          return;
        }
        const producer =
          rec.producer && typeof rec.producer === "object"
            ? (rec.producer as Producer)
            : (opts.producer ?? INTERNAL_PRODUCER);
        const correlation_id =
          typeof rec.correlation_id === "string"
            ? rec.correlation_id
            : opts.bus.run_id;
        await opts.bus.emit({
          name: rec.name,
          payload: rec.payload as PayloadMap[typeof rec.name],
          producer,
          correlation_id,
          ...(typeof rec.causation_id === "string"
            ? { causation_id: rec.causation_id }
            : {}),
          ...(typeof rec.id === "string" ? { id: rec.id } : {}),
        });
        json(res, 200, { ok: true });
        return;
      }
      const handler = handlers.get(url);
      if (!handler) {
        json(res, 404, { ok: false, error: "not found" });
        return;
      }
      await handler(req as IncomingMessage & { rawBody?: Buffer }, res, body);
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        json(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, bind, () => resolve());
  });

  const address = server.address();
  const port =
    address && typeof address === "object" ? address.port : requestedPort;
  const pidDir = path.join(cwd, ".latticeag");
  mkdirSync(pidDir, { recursive: true });
  const pidFile = ingestPidPath(cwd);
  writeFileSync(pidFile, `${process.pid}\n`);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    if (existsSync(pidFile)) {
      const raw = readFileSync(pidFile, "utf8").trim();
      if (raw === String(process.pid)) {
        unlinkSync(pidFile);
      }
    }
  };

  return {
    url: `http://${bind}:${port}${ingestPath}`,
    bind,
    port,
    registerIngest,
    close,
  };
}

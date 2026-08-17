/**
 * Child mode bus. POSTs ingest, never writes JSONL. Spec C16 / 10.3.
 */
import { readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { parseEnvelope } from "@latticeag/events";
import type {
  AnyLatticeEvent,
  Envelope,
  EventName,
  PayloadMap,
} from "@latticeag/events";
import { LatticeAGError, StageTimeoutError } from "./errors.js";
import type { BusOptions } from "./types.js";
import { redactValue } from "./integration/redact.js";
import type { EmitPartial, Subscriber } from "@latticeag/bus";

export interface IngestBusOptions {
  ingest_url: string;
  run_id: string;
  session_id: string;
  log_path?: string;
  redact_keys: string[];
  include_raw_text: boolean;
  overflow_block_ms?: number;
}

export class IngestBus {
  readonly run_id: string;
  readonly session_id: string;
  readonly log_path: string;
  #lastSeq = 0;
  #subscribers: Array<{ name: EventName | "*"; fn: Subscriber }> = [];
  #closed = false;
  #options: IngestBusOptions;
  #poll: ReturnType<typeof setInterval> | undefined;
  #watcher: ReturnType<typeof watch> | undefined;
  #offset = 0;
  #buffer = "";

  constructor(options: IngestBusOptions) {
    this.run_id = options.run_id;
    this.session_id = options.session_id;
    this.log_path = options.log_path ?? "";
    this.#options = options;
    if (this.log_path.length > 0) {
      this.#startTail();
    }
  }

  seq(): number {
    return this.#lastSeq;
  }

  subscribe(name: EventName | "*", fn: Subscriber): () => void {
    const entry = { name, fn };
    this.#subscribers.push(entry);
    return () => {
      this.#subscribers = this.#subscribers.filter((item) => item !== entry);
    };
  }

  async emit<N extends EventName>(partial: EmitPartial<N>): Promise<AnyLatticeEvent> {
    const walked = redactValue(
      {
        name: partial.name,
        payload: partial.payload,
        producer: partial.producer,
        causation_id: partial.causation_id,
        correlation_id: partial.correlation_id ?? this.run_id,
      },
      this.#options.redact_keys,
      this.#options.include_raw_text,
    );
    const body = walked.value as {
      name: EventName;
      payload: PayloadMap[N];
      producer: EmitPartial<N>["producer"];
      causation_id?: string;
      correlation_id: string;
    };

    const url = ingestGenericUrl(this.#options.ingest_url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new StageTimeoutError("STAGE_TIMEOUT", `ingest POST timed out: ${url}`, {
        cause: err,
      });
    }
    clearTimeout(timer);

    if (response.status < 200 || response.status >= 300) {
      throw new LatticeAGError(
        `INGEST_HTTP_${response.status}`,
        `ingest POST ${url} returned ${response.status}`,
      );
    }

    const text = await response.text();
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as { id?: string; seq?: number } & Partial<AnyLatticeEvent>;
        if (typeof parsed.id === "string" && typeof parsed.seq === "number") {
          this.#lastSeq = parsed.seq;
          if (parsed.name !== undefined && parsed.payload !== undefined) {
            const event = parseEnvelope(parsed);
            this.#fanout(event);
            return event;
          }
          const synthetic = {
            ...body,
            $schema: "latticeag.events/1.0" as const,
            schema_version: 1 as const,
            id: parsed.id,
            seq: parsed.seq,
            ts: new Date().toISOString(),
            run_id: this.run_id,
            session_id: this.session_id,
            redaction: {
              applied: true,
              keys: [...this.#options.redact_keys],
              pattern_hits: walked.pattern_hits,
            },
          };
          const event = parseEnvelope(synthetic);
          this.#fanout(event);
          return event;
        }
      } catch {
        // fall through to tail
      }
    }

    return this.#waitForMatch(body.name, body.causation_id);
  }

  async *replay(path: string, fromSeq: number): AsyncIterable<AnyLatticeEvent> {
    const text = await readFile(path, "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const parsed = parseEnvelope(JSON.parse(line) as unknown);
      if (parsed.seq >= fromSeq) {
        yield parsed;
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#poll !== undefined) {
      clearInterval(this.#poll);
    }
    this.#watcher?.close();
  }

  #startTail(): void {
    const tick = (): void => {
      void this.#readNew();
    };
    this.#poll = setInterval(tick, 250);
    try {
      this.#watcher = watch(this.log_path, tick);
    } catch {
      // file may not exist yet; poll will pick it up
    }
  }

  async #readNew(): Promise<void> {
    if (this.log_path.length === 0) {
      return;
    }
    try {
      const info = await stat(this.log_path);
      if (info.size < this.#offset) {
        this.#offset = 0;
        this.#buffer = "";
      }
      if (info.size === this.#offset) {
        return;
      }
      const handle = await readFile(this.log_path);
      const chunk = handle.subarray(this.#offset);
      this.#offset = info.size;
      this.#buffer += chunk.toString("utf8");
      const lines = this.#buffer.split("\n");
      this.#buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") {
          continue;
        }
        try {
          const event = parseEnvelope(JSON.parse(line) as unknown);
          this.#lastSeq = Math.max(this.#lastSeq, event.seq);
          this.#fanout(event);
        } catch {
          // skip bad line
        }
      }
    } catch {
      // not created yet
    }
  }

  #fanout(event: AnyLatticeEvent): void {
    for (const sub of this.#subscribers) {
      if (sub.name !== "*" && sub.name !== event.name) {
        continue;
      }
      try {
        void sub.fn(event);
      } catch {
        // parent bus owns adapter_error
      }
    }
  }

  async #waitForMatch(name: string, causation_id: string | undefined): Promise<AnyLatticeEvent> {
    const waitMs = this.#options.overflow_block_ms ?? 5000;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await this.#readNew();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new StageTimeoutError(
      "STAGE_TIMEOUT",
      `ingest ack missing for ${name}${causation_id ? ` causation_id=${causation_id}` : ""}`,
    );
  }
}

function ingestGenericUrl(ingest_url: string): string {
  if (ingest_url.endsWith("/generic")) {
    return ingest_url;
  }
  return `${ingest_url.replace(/\/$/, "")}/generic`;
}

export type { Envelope, PayloadMap, BusOptions };

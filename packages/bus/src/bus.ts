import {
  EnvelopeTooLargeError,
  LATTICEAG_EVENTS_SCHEMA,
  MAX_ENVELOPE_BYTES,
  type AnyLatticeEvent,
  type BusOverflowPayload,
  type Envelope,
  type EventName,
  type PayloadMap,
  type Producer,
  type RedactionStamp,
} from "@latticeag/events";
import { JsonlLog, JsonlReader } from "./jsonl.js";
import { newEnvelopeId } from "./ids.js";
import { mergeRedactKeys, redactDeep } from "./redact.js";

const INTERNAL_PRODUCER: Producer = {
  product: "latticeag",
  adapter: "latticeag-internal",
  adapter_version: "0.1.0",
};

const DEFAULT_MAX_LOG_BYTES = 268435456;

export class BusPersistError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BusPersistError";
  }
}

export interface BusOptions {
  run_id: string;
  session_id: string;
  log_path: string;
  ring_capacity: number;
  overflow_block_ms: number;
  overflow: "block_then_drop" | "drop";
  persist_fail: "throw" | "log";
  redact_keys: string[];
  include_raw_text: boolean;
  max_log_bytes: number;
}

export type Subscriber = (event: AnyLatticeEvent) => void | Promise<void>;

export type EmitPartial<N extends EventName> = Omit<
  Envelope<N, PayloadMap[N]>,
  "id" | "seq" | "ts" | "run_id" | "session_id" | "$schema" | "schema_version" | "redaction"
> & {
  id?: string;
  ts?: string;
  redaction?: RedactionStamp;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorName(err: unknown): string | undefined {
  return err instanceof Error ? err.name : undefined;
}

interface PersistResult {
  event: AnyLatticeEvent;
  followUps: AnyLatticeEvent[];
}

export class LatticeBus {
  readonly run_id: string;
  readonly session_id: string;

  readonly #options: BusOptions;
  readonly #log: JsonlLog;
  readonly #redactKeys: Set<string>;
  readonly #ring: AnyLatticeEvent[] = [];
  readonly #subscribers = new Map<string, Set<Subscriber>>();
  #seq = 0;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: BusOptions) {
    this.run_id = options.run_id;
    this.session_id = options.session_id;
    this.#options = {
      ...options,
      max_log_bytes: options.max_log_bytes ?? DEFAULT_MAX_LOG_BYTES,
    };
    this.#log = new JsonlLog(this.#options.log_path, this.#options.max_log_bytes);
    this.#redactKeys = mergeRedactKeys(this.#options.redact_keys);
  }

  seq(): number {
    return this.#seq;
  }

  subscribe(name: EventName | "*", fn: Subscriber): () => void {
    let set = this.#subscribers.get(name);
    if (!set) {
      set = new Set();
      this.#subscribers.set(name, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  emit<N extends EventName>(partial: EmitPartial<N>): Promise<AnyLatticeEvent> {
    const persisted = this.#enqueue(() => this.#persist(partial));
    return persisted.then((result) => {
      this.#dispatch(result.event);
      for (const follow of result.followUps) {
        this.#dispatch(follow);
      }
      return result.event;
    });
  }

  async *replay(path: string, fromSeq: number): AsyncIterable<AnyLatticeEvent> {
    const reader = new JsonlReader(path);
    for await (const event of reader.events()) {
      if (event.seq >= fromSeq) {
        yield event;
      }
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#closePromise = this.#doClose();
    return this.#closePromise;
  }

  async #doClose(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    await this.#log.flush();
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #persist<N extends EventName>(partial: EmitPartial<N>): Promise<PersistResult> {
    if (this.#closed) {
      throw new Error("LatticeBus is closed");
    }

    this.#seq += 1;
    const seq = this.#seq;
    let event = this.#fill(partial, seq);
    const redacted = redactDeep(event, this.#redactKeys, this.#options.include_raw_text);
    event = redacted.value;
    event.redaction = partial.redaction ?? redacted.stamp;

    const serialized = JSON.stringify(event);
    if (serialized.length > MAX_ENVELOPE_BYTES) {
      this.#seq -= 1;
      throw new EnvelopeTooLargeError(serialized.length);
    }

    const followUps: AnyLatticeEvent[] = [];
    let droppedFromRing = false;

    if (this.#ring.length >= this.#options.ring_capacity) {
      if (this.#options.overflow === "block_then_drop") {
        await sleep(this.#options.overflow_block_ms);
      }
      droppedFromRing = true;
    } else {
      this.#ring.push(event);
    }

    let rotated = false;
    try {
      const result = await this.#log.appendEvent(event);
      rotated = result.rotated;
    } catch (err) {
      if (this.#options.persist_fail === "throw") {
        throw new BusPersistError("failed to persist event to JSONL", { cause: err });
      }
      console.error(`BusPersistError: failed to persist event to JSONL: ${errorMessage(err)}`);
    }

    if (droppedFromRing) {
      followUps.push(
        await this.#writeDiagnostic(
          {
            name: "bus_overflow",
            producer: INTERNAL_PRODUCER,
            correlation_id: event.correlation_id,
            causation_id: event.id,
            payload: {
              reason: "capacity",
              dropped_id: event.id,
              dropped_name: event.name,
              ring_size: this.#ring.length,
              ring_capacity: this.#options.ring_capacity,
            } satisfies BusOverflowPayload,
          },
        ),
      );
    }

    if (rotated) {
      followUps.push(
        await this.#writeDiagnostic(
          {
            name: "bus_overflow",
            producer: INTERNAL_PRODUCER,
            correlation_id: event.correlation_id,
            causation_id: event.id,
            payload: {
              reason: "rotate",
              ring_size: this.#ring.length,
              ring_capacity: this.#options.ring_capacity,
            } satisfies BusOverflowPayload,
          },
        ),
      );
    }

    return { event, followUps };
  }

  async #writeDiagnostic(partial: EmitPartial<"bus_overflow"> | EmitPartial<"adapter_error">): Promise<AnyLatticeEvent> {
    this.#seq += 1;
    let event = this.#fill(partial, this.#seq);
    const redacted = redactDeep(event, this.#redactKeys, this.#options.include_raw_text);
    event = redacted.value;
    event.redaction = redacted.stamp;

    if (this.#ring.length >= this.#options.ring_capacity) {
      this.#ring.shift();
    }
    this.#ring.push(event);

    try {
      await this.#log.appendEvent(event);
    } catch (err) {
      if (this.#options.persist_fail === "throw") {
        throw new BusPersistError("failed to persist diagnostic event to JSONL", {
          cause: err,
        });
      }
      console.error(
        `BusPersistError: failed to persist diagnostic event to JSONL: ${errorMessage(err)}`,
      );
    }

    return event;
  }

  #fill<N extends EventName>(partial: EmitPartial<N>, seq: number): AnyLatticeEvent {
    const event: Envelope<N, PayloadMap[N]> = {
      $schema: LATTICEAG_EVENTS_SCHEMA,
      schema_version: 1,
      id: partial.id ?? newEnvelopeId(),
      seq,
      ts: partial.ts ?? new Date().toISOString(),
      run_id: this.run_id,
      session_id: this.session_id,
      producer: partial.producer,
      correlation_id: partial.correlation_id,
      redaction: { applied: false, keys: [], pattern_hits: 0 },
      name: partial.name,
      payload: partial.payload,
    };
    if (partial.causation_id !== undefined) {
      event.causation_id = partial.causation_id;
    }
    // Generic Envelope<N, PayloadMap[N]> is not assignable to the closed
    // AnyLatticeEvent union; N is already constrained to EventName.
    return event as AnyLatticeEvent;
  }

  #dispatch(event: AnyLatticeEvent): void {
    const fns: Subscriber[] = [];
    const star = this.#subscribers.get("*");
    if (star) {
      fns.push(...star);
    }
    const named = this.#subscribers.get(event.name);
    if (named) {
      fns.push(...named);
    }
    for (const fn of fns) {
      queueMicrotask(() => {
        void Promise.resolve()
          .then(() => fn(event))
          .catch((err: unknown) => {
            this.#onSubscriberError(event, err);
          });
      });
    }
  }

  #onSubscriberError(event: AnyLatticeEvent, err: unknown): void {
    if (event.name === "adapter_error") {
      return;
    }
    void this.emit({
      name: "adapter_error",
      producer: INTERNAL_PRODUCER,
      correlation_id: event.correlation_id,
      causation_id: event.id,
      payload: {
        adapter: "latticeag-internal",
        message: errorMessage(err),
        cause_name: errorName(err),
        event_id: event.id,
      },
    }).catch((persistErr: unknown) => {
      console.error(
        `BusPersistError: failed to emit adapter_error: ${errorMessage(persistErr)}`,
      );
    });
  }
}

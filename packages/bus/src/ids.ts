import { ulid } from "ulid";

/** Crockford ULID, same shape as @latticeag/events envelope id. */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function newEnvelopeId(): string {
  return ulid();
}

export function newRunId(): string {
  return ulid();
}

/** Axion session id when present; otherwise `ses_` plus a ULID (D15). */
export function newSessionId(): string {
  return `ses_${ulid()}`;
}

export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}

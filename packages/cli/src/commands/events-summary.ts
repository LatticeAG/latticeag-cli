import {
  EVENT_NAMES,
  type AnyLatticeEvent,
  type EventName,
} from "@latticeag/events";

const EVENT_NAME_SET = new Set<string>(EVENT_NAMES);

const SECRET_RE =
  /sk-[a-zA-Z0-9]{10,}|vk_live_[a-zA-Z0-9]+|vk_test_[a-zA-Z0-9]+|Bearer\s+\S+/gi;

function sanitize(text: string): string {
  return text.replace(SECRET_RE, "[REDACTED]").replace(/[\t\r\n]+/g, " ").trim();
}

function conf(value: number): string {
  return value.toFixed(2);
}

export function isUnknownLatticeEvent(event: AnyLatticeEvent): boolean {
  return !EVENT_NAME_SET.has(event.name);
}

export function summarizeEvent(event: AnyLatticeEvent): string {
  if (isUnknownLatticeEvent(event)) {
    return "";
  }
  const name = event.name as EventName;
  const payload = event.payload as Record<string, unknown>;
  switch (name) {
    case "belief_extracted": {
      const belief = payload.belief as {
        type?: string;
        confidence?: number;
        text?: string;
      };
      return sanitize(
        `${belief.type ?? ""} ${conf(belief.confidence ?? 0)}  ${belief.text ?? ""}`,
      );
    }
    case "policy_decision": {
      const tool = payload.tool as { name?: string } | undefined;
      return sanitize(
        `${payload.decision ?? ""} ${tool?.name ?? ""} ${payload.reason ?? ""}`,
      );
    }
    case "verdict": {
      const message =
        typeof payload.message === "string" ? payload.message : "";
      return sanitize(
        `${payload.verdict ?? ""} ${conf(Number(payload.confidence) || 0)} ${message}`,
      );
    }
    case "approval_granted": {
      return sanitize(
        `${payload.status ?? ""} ${payload.title ?? ""} ${payload.action ?? ""}`,
      );
    }
    case "compensation_executed": {
      return sanitize(
        `${payload.state_from ?? ""}->${payload.state_to ?? ""} ${payload.action ?? ""}`,
      );
    }
    case "receipt_issued": {
      return sanitize(`${payload.tier ?? ""} ${payload.action ?? ""}`);
    }
    case "session_recorded": {
      return sanitize(
        `${payload.session_name ?? ""} events=${payload.event_count ?? 0}`,
      );
    }
    case "diff_computed": {
      const summary = payload.summary as
        | {
            added?: number;
            removed?: number;
            changed?: number;
            regressions?: number;
          }
        | undefined;
      return sanitize(
        `+${summary?.added ?? 0} -${summary?.removed ?? 0} ~${summary?.changed ?? 0} regressions=${summary?.regressions ?? 0}`,
      );
    }
    case "tool_observed": {
      return sanitize(`${payload.source ?? ""} ${payload.name ?? ""}`);
    }
    case "extension": {
      return sanitize(String(payload.extension_name ?? ""));
    }
    case "bus_overflow": {
      return sanitize(
        `${payload.reason ?? ""} ${payload.ring_size ?? 0}/${payload.ring_capacity ?? 0}`,
      );
    }
    case "adapter_error": {
      return sanitize(`${payload.adapter ?? ""} ${payload.message ?? ""}`);
    }
    default:
      return "";
  }
}

export function formatTextEvent(event: AnyLatticeEvent): string {
  const seq = String(event.seq).padStart(5, "0");
  const summary = summarizeEvent(event);
  const base = `${event.ts}  ${seq}  ${event.name}  ${event.producer.product}`;
  return summary.length > 0 ? `${base}  ${summary}` : base;
}

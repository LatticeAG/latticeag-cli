import { Box, Text, useApp, useInput } from "ink";
import { createElement, useEffect, useMemo, useState, type ReactElement } from "react";
import { render, type Instance } from "ink";
import type { AnyLatticeEvent } from "@latticeag/events";

export interface TuiHealth {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface TuiEventRow {
  ts: string;
  name: string;
  product: string;
  summary: string;
}

export interface EventsAppProps {
  runId: string;
  seq: number;
  health: TuiHealth[];
  events: TuiEventRow[];
  frozen?: boolean;
  filter?: string;
}

export function formatClock(ts: string): string {
  return ts.length >= 23 ? ts.slice(11, 23) : ts;
}

export function formatHealth(health: TuiHealth[]): string {
  if (health.length === 0) {
    return "adapters none";
  }
  return `adapters ${health
    .map((h) => `${h.id}:${h.ok ? "ok" : "down"}`)
    .join(" ")}`;
}

export function EventsApp(props: EventsAppProps): ReactElement {
  const filter = (props.filter ?? "").trim().toLowerCase();
  const rows = props.events
    .filter((row) => (filter.length === 0 ? true : row.name.toLowerCase().includes(filter)))
    .slice(-50);
  return (
    <Box flexDirection="column">
      <Text>run_id {props.runId}</Text>
      <Text>seq {props.seq}</Text>
      <Text>{formatHealth(props.health)}</Text>
      {rows.map((row, i) => (
        <Text key={`${row.ts}-${row.name}-${i}`}>
          {formatClock(row.ts)}  {row.name}  {row.product}  {row.summary}
        </Text>
      ))}
    </Box>
  );
}

export interface DevAppProps {
  runId: string;
  getSeq: () => number;
  getEvents: () => AnyLatticeEvent[];
  getHealth: () => TuiHealth[];
  summarize: (event: AnyLatticeEvent) => string;
  onQuit: () => void;
}

export function DevApp(props: DevAppProps): ReactElement {
  const { exit } = useApp();
  const [frozen, setFrozen] = useState(false);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [tick, setTick] = useState(0);
  const [snapshot, setSnapshot] = useState<TuiEventRow[]>([]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!frozen) {
        setTick((n) => n + 1);
      }
    }, 200);
    return () => {
      clearInterval(timer);
    };
  }, [frozen]);

  useInput((input, key) => {
    if (filtering) {
      if (key.return) {
        setFiltering(false);
        return;
      }
      if (key.escape) {
        setFilter("");
        setFiltering(false);
        return;
      }
      if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1));
        return;
      }
      if (input && !key.ctrl) {
        setFilter((f) => f + input);
      }
      return;
    }
    if (input === "q") {
      props.onQuit();
      exit();
      return;
    }
    if (input === "f") {
      setFrozen((value) => {
        const next = !value;
        if (next) {
          setSnapshot(
            props.getEvents().map((event) => ({
              ts: event.ts,
              name: event.name,
              product: event.producer.product,
              summary: props.summarize(event),
            })),
          );
        }
        return next;
      });
      return;
    }
    if (input === "/") {
      setFiltering(true);
    }
  });

  const liveRows: TuiEventRow[] = useMemo(() => {
    void tick;
    return props.getEvents().map((event) => ({
      ts: event.ts,
      name: event.name,
      product: event.producer.product,
      summary: props.summarize(event),
    }));
  }, [tick, props]);

  const rows = frozen ? snapshot : liveRows;

  return (
    <EventsApp
      runId={props.runId}
      seq={props.getSeq()}
      health={props.getHealth()}
      events={rows}
      frozen={frozen}
      filter={filter}
    />
  );
}

export function renderDevApp(props: DevAppProps): Instance {
  return render(createElement(DevApp, props));
}

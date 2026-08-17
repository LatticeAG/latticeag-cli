import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { EventsApp, type TuiEventRow } from "./app.js";

const EVENTS: TuiEventRow[] = [
  {
    ts: "2026-08-17T13:57:00.123Z",
    name: "belief_extracted",
    product: "axion",
    summary: "assumption 0.50 staging shares prod credentials",
  },
  {
    ts: "2026-08-17T13:57:01.000Z",
    name: "tool_observed",
    product: "visreplay",
    summary: "visreplay write_file",
  },
  {
    ts: "2026-08-17T13:57:02.456Z",
    name: "verdict",
    product: "lexverdict",
    summary: "pass 0.90",
  },
];

describe("EventsApp", () => {
  it("dumps three events", () => {
    const { lastFrame } = render(
      createElement(EventsApp, {
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        seq: 3,
        health: [
          { id: "axion", ok: true },
          { id: "lexverdict", ok: false },
        ],
        events: EVENTS,
      }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("run_id 01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(frame).toContain("seq 3");
    expect(frame).toContain("axion:ok");
    expect(frame).toContain("lexverdict:down");
    expect(frame).toContain("13:57:00.123  belief_extracted  axion");
    expect(frame).toContain("13:57:01.000  tool_observed  visreplay");
    expect(frame).toContain("13:57:02.456  verdict  lexverdict");
  });
});

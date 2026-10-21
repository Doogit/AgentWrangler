/**
 * Swimlane timeline: one row per chain (main + each subagent) on a wall-clock axis, with idle
 * gaps over 30 minutes compressed. Turns are colored by model; red ticks mark tool errors,
 * dashed violet lines compactions, diamonds commits. Custom SVG (recharts has no Gantt).
 */
import { type FocusEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import type { SessionStory, StoryLane, StoryTurn } from "../../query/api/session-story";
import Chip from "../shell/Chip";
import InfoTip from "../shell/InfoTip";
import { modelColor, prettyModel, usdU } from "./SessionStory";

const MAX_ROWS = 15;
const IDLE_GAP_MS = 30 * 60_000;
const MAX_TURN_MS = 3 * 60_000;
const ROW_H = 22;
const AXIS_H = 22;

interface Row {
  id: string;
  label: string;
  cost_u: number;
  turns: number;
  models: string[];
  merged: number;
}

/** Main, then the costliest subagents by start time; the rest share one "Other subagents" row. */
export function laneRows(lanes: StoryLane[]): { rows: Row[]; rowOf: (laneId: string) => string } {
  const main = lanes.filter((l) => l.is_main);
  const subs = lanes.filter((l) => !l.is_main);
  const room = MAX_ROWS - main.length;
  const keep =
    subs.length <= room
      ? subs
      : [...subs]
          .sort((a, b) => b.cost_u - a.cost_u)
          .slice(0, room - 1)
          .sort((a, b) => a.first_ts.localeCompare(b.first_ts));
  const kept = new Set(keep.map((l) => l.lane_id));
  const rest = subs.filter((l) => !kept.has(l.lane_id));
  const rows: Row[] = [...main, ...keep].map((l) => ({
    id: l.lane_id,
    label: l.label,
    cost_u: l.cost_u,
    turns: l.turns,
    models: l.models,
    merged: 1,
  }));
  if (rest.length > 0) {
    rows.push({
      id: "__other",
      label: `Other subagents (${rest.length})`,
      cost_u: rest.reduce((s, l) => s + l.cost_u, 0),
      turns: rest.reduce((s, l) => s + l.turns, 0),
      models: [...new Set(rest.flatMap((l) => l.models))],
      merged: rest.length,
    });
  }
  return { rows, rowOf: (laneId) => (kept.has(laneId) || laneId === "main" ? laneId : "__other") };
}

export interface TimeScale {
  /** Compressed position of a wall-clock time, in ms from the start. */
  at: (ms: number) => number;
  span: number;
  gaps: Array<{ from: number; to: number; ms: number }>;
}

/** Piecewise-linear wall clock where every idle gap over 30 minutes shrinks to a fixed width. */
export function compressedScale(times: number[]): TimeScale {
  const pts = [...new Set(times)].sort((a, b) => a - b);
  if (pts.length === 0) return { at: () => 0, span: 1, gaps: [] };
  let active = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i] as number) - (pts[i - 1] as number);
    if (d <= IDLE_GAP_MS) active += d;
  }
  const gapWidth = Math.max(active * 0.03, 60_000);
  const c = [0];
  const gaps: TimeScale["gaps"] = [];
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i] as number) - (pts[i - 1] as number);
    const prev = c[i - 1] as number;
    c.push(prev + (d > IDLE_GAP_MS ? gapWidth : d));
    if (d > IDLE_GAP_MS) gaps.push({ from: prev, to: prev + gapWidth, ms: d });
  }
  const at = (ms: number) => {
    if (ms <= (pts[0] as number)) return 0;
    let lo = 0;
    let hi = pts.length - 1;
    if (ms >= (pts[hi] as number)) return (c[hi] as number) + (ms - (pts[hi] as number));
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((pts[mid] as number) <= ms) lo = mid;
      else hi = mid;
    }
    const p0 = pts[lo] as number;
    const p1 = pts[hi] as number;
    const c0 = c[lo] as number;
    const c1 = c[hi] as number;
    return c0 + ((ms - p0) / (p1 - p0)) * (c1 - c0);
  };
  return { at, span: Math.max(c[c.length - 1] as number, 1), gaps };
}

function fmtGap(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

interface Segment {
  row: number;
  model: string;
  x0: number;
  x1: number;
  first: number;
  last: number;
  turns: number;
  cost_u: number;
  errors: number;
}

interface Hover {
  x: number;
  y: number;
  text: string;
}

export function SessionSwimlane({ story }: { story: SessionStory }) {
  const { ref, width } = useWidth(800);
  const [hover, setHover] = useState<Hover | null>(null);
  if (story.turns.length === 0) return null;

  const { rows, rowOf } = laneRows(story.lanes);
  const rowIndex = new Map(rows.map((r, i) => [r.id, i]));
  const turnMs = story.turns.map((t) => Date.parse(t.ts));
  const commitMs = story.commits.map((c) => Date.parse(c.ts));
  const scale = compressedScale([...turnMs, ...commitMs]);
  const pad = 6;
  const x = (ms: number) => pad + (scale.at(ms) / scale.span) * (width - pad * 2);
  const height = rows.length * ROW_H + AXIS_H;
  const t0 = turnMs.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
  const t1 = turnMs.reduce((a, b) => Math.max(a, b), 0);

  // Each turn runs until the next turn in its lane, capped so a long wait doesn't paint a bar.
  const nextInLane = new Map<string, number>();
  const ends: number[] = new Array(story.turns.length);
  for (let i = story.turns.length - 1; i >= 0; i--) {
    const t = story.turns[i] as StoryTurn;
    const start = turnMs[i] as number;
    const next = nextInLane.get(t.lane_id);
    ends[i] = Math.min(next ?? start + 30_000, start + MAX_TURN_MS);
    nextInLane.set(t.lane_id, start);
  }
  // Turns that touch (same row and model, under 2px apart) merge into one bar, so dense
  // stretches read as one block instead of overlapping slivers.
  const segments: Segment[] = [];
  const open = new Map<string, Segment>();
  const ticks = new Set<string>();
  const errorTicks: Array<{ row: number; x: number }> = [];
  story.turns.forEach((t, i) => {
    const row = rowIndex.get(rowOf(t.lane_id)) ?? 0;
    const sx = x(turnMs[i] as number);
    const ex = Math.max(x(ends[i] as number), sx + 2);
    const key = `${row}|${t.model}`;
    const cur = open.get(key);
    if (cur !== undefined && sx <= cur.x1 + 2) {
      cur.x1 = Math.max(cur.x1, ex);
      cur.last = turnMs[i] as number;
      cur.turns += 1;
      cur.cost_u += t.cost_u;
      if (t.error) cur.errors += 1;
    } else {
      const seg: Segment = {
        row,
        model: t.model,
        x0: sx,
        x1: ex,
        first: turnMs[i] as number,
        last: turnMs[i] as number,
        turns: 1,
        cost_u: t.cost_u,
        errors: t.error ? 1 : 0,
      };
      segments.push(seg);
      open.set(key, seg);
    }
    const px = Math.round(sx);
    if (t.error && !ticks.has(`${row}|${px}`)) {
      ticks.add(`${row}|${px}`);
      errorTicks.push({ row, x: px });
    }
  });
  const models = [...new Set(story.turns.map((t) => t.model))];
  const show = (e: MouseEvent, text: string) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setHover({ x: e.clientX - box.left, y: e.clientY - box.top, text });
  };
  // Keyboard focus shows the same tooltip, placed at the focused shape.
  const showAt = (e: FocusEvent<SVGElement>, text: string) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const at = e.currentTarget.getBoundingClientRect();
    setHover({ x: at.left - box.left, y: at.top - box.top, text });
  };
  const hide = () => setHover(null);
  const errors = story.turns.filter((t) => t.error).length;
  const compactions = story.turns.filter((t) => t.compaction).length;

  return (
    <section className="sec" data-testid="session-swimlane">
      <div className="sec-h">
        <h2>
          Timeline{" "}
          <InfoTip
            label="What the timeline shows"
            content="One row per chain: the main conversation and each subagent, on a wall-clock axis. Each block is a turn, colored by model, so you can see when subagents ran in parallel and which ran on expensive models. Idle gaps over 30 minutes are squeezed and labeled. Turns that run back to back merge into one block; hover a block for its turns and cost. Red ticks under a block are tool errors, dashed violet lines compactions, diamonds commits."
          />
        </h2>
        <span className="desc">
          <Chip kind="OBS_PROXY" />
        </span>
      </div>
      <div className="card swimlane-card">
        <div className="swimlane">
          <ul className="swimlane-labels" style={{ paddingBottom: AXIS_H }}>
            {rows.map((r) => (
              <li
                key={r.id}
                style={{ height: ROW_H }}
                title={`${r.turns} turns · ${r.models.map(prettyModel).join(", ")}`}
                data-testid="swimlane-row-label"
              >
                <span className="swimlane-label-name">{r.label}</span>
                <span className="section-meta">{usdU(r.cost_u)}</span>
              </li>
            ))}
          </ul>
          <div className="swimlane-plot" ref={ref} onMouseLeave={hide}>
            <svg
              width={width}
              height={height}
              aria-label={`Timeline of ${story.turns.length} turns across ${story.lanes.length} chains`}
            >
              <title>{`Timeline of ${story.turns.length} turns across ${story.lanes.length} chains`}</title>
              {rows.map((r, i) => (
                <rect
                  key={`bg-${r.id}`}
                  x={0}
                  y={i * ROW_H}
                  width={width}
                  height={ROW_H}
                  fill={i % 2 === 0 ? "var(--panel)" : "var(--panel2)"}
                />
              ))}
              {scale.gaps.map((g) => {
                const gx = pad + (g.from / scale.span) * (width - pad * 2);
                const gw = ((g.to - g.from) / scale.span) * (width - pad * 2);
                return (
                  <g key={`gap-${g.from}`} data-testid="swimlane-gap">
                    <rect
                      x={gx}
                      y={0}
                      width={Math.max(gw, 4)}
                      height={rows.length * ROW_H}
                      fill="var(--bg)"
                      opacity={0.6}
                    />
                    <text
                      x={gx + gw / 2}
                      y={rows.length * ROW_H + 15}
                      textAnchor="middle"
                      fontSize={10}
                      fill="var(--muted)"
                    >
                      ⋯ {fmtGap(g.ms)} idle
                    </text>
                  </g>
                );
              })}
              {segments.map((s) => {
                const y = s.row * ROW_H;
                const text = `${new Date(s.first).toLocaleTimeString()}${s.turns > 1 ? `–${new Date(s.last).toLocaleTimeString()}` : ""} · ${prettyModel(s.model)} · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${usdU(s.cost_u)}${s.errors > 0 ? ` · ${s.errors} tool error${s.errors === 1 ? "" : "s"}` : ""}`;
                return (
                  <rect
                    key={`${s.row}-${s.x0}-${s.model}`}
                    onMouseEnter={(e) => show(e, text)}
                    onFocus={(e) => showAt(e, text)}
                    onBlur={hide}
                    tabIndex={0}
                    aria-label={text}
                    data-testid="swimlane-turn"
                    x={s.x0}
                    y={y + 5}
                    width={Math.max(s.x1 - s.x0, 2)}
                    height={ROW_H - 12}
                    rx={2}
                    fill={modelColor(s.model)}
                  />
                );
              })}
              {errorTicks.map((t) => (
                <rect
                  key={`err-${t.row}-${t.x}`}
                  x={t.x}
                  y={t.row * ROW_H + ROW_H - 5}
                  width={2}
                  height={4}
                  fill="var(--red)"
                  data-testid="swimlane-error"
                />
              ))}
              {story.turns.map((t, i) =>
                t.compaction ? (
                  <line
                    key={`cmp-${t.ts}-${i}`}
                    x1={x(turnMs[i] as number)}
                    x2={x(turnMs[i] as number)}
                    y1={(rowIndex.get(rowOf(t.lane_id)) ?? 0) * ROW_H}
                    y2={((rowIndex.get(rowOf(t.lane_id)) ?? 0) + 1) * ROW_H}
                    stroke="var(--violet)"
                    strokeWidth={2}
                    strokeDasharray="3 2"
                  />
                ) : null,
              )}
              {story.commits.map((c, i) => {
                const cx = x(commitMs[i] as number);
                const cy = 6;
                const text = `Commit ${c.sha.slice(0, 7)} · ${new Date(c.ts).toLocaleTimeString()}`;
                return (
                  <polygon
                    key={c.sha}
                    points={`${cx},${cy - 5} ${cx + 5},${cy} ${cx},${cy + 5} ${cx - 5},${cy}`}
                    fill="var(--green)"
                    stroke="var(--panel)"
                    strokeWidth={1}
                    data-testid="swimlane-commit"
                    onMouseEnter={(e) => show(e, text)}
                    onFocus={(e) => showAt(e, text)}
                    onBlur={hide}
                    tabIndex={0}
                    aria-label={text}
                  />
                );
              })}
              <text x={pad} y={height - 6} fontSize={10} fill="var(--muted)">
                {new Date(t0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </text>
              <text
                x={width - pad}
                y={height - 6}
                fontSize={10}
                fill="var(--muted)"
                textAnchor="end"
              >
                {new Date(t1).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </text>
            </svg>
            {hover !== null && (
              <div
                className="chart-tip swimlane-tip"
                style={{ left: Math.min(hover.x + 12, width - 220), top: hover.y + 12 }}
                role="tooltip"
              >
                {hover.text}
              </div>
            )}
          </div>
        </div>
        <ul className="money-legend swimlane-legend">
          {models.map((m) => (
            <li key={m}>
              <span
                className="money-swatch"
                style={{ background: modelColor(m) }}
                aria-hidden="true"
              />
              {prettyModel(m)}
            </li>
          ))}
          {errors > 0 && <li>red tick under a block: tool error ({errors})</li>}
          {compactions > 0 && <li>dashed violet: compaction ({compactions})</li>}
          {story.commits.length > 0 && <li>green ◆: commit ({story.commits.length})</li>}
        </ul>
      </div>
    </section>
  );
}

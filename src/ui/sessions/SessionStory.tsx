/**
 * Session page panels built on GET /api/sessions/:id/story: the header's first prompt,
 * "Where the money went", the full-session context and cost chart, and grouped tool errors.
 */
import { Fragment, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TurnRow } from "../../query/api/overview";
import type { SessionStory, StoryErrorGroup } from "../../query/api/session-story";
import { gridProps, seriesPalette } from "../overview/chart-theme";
import Chip from "../shell/Chip";
import { ChartAfterPaint, NextTask } from "../shell/DeferredChart";
import InfoTip from "../shell/InfoTip";

/** "claude-opus-4-8" → "Opus 4.8"; date suffixes dropped (mirrors the API's prettyModel). */
export function prettyModel(model: string): string {
  const [family, ...version] = model
    .replace(/^claude-/, "")
    .split("-")
    .filter((p) => !/^\d{8}$/.test(p));
  if (family === undefined) return model;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return version.length > 0 ? `${name} ${version.join(".")}` : name;
}

/** One stable series color per model family, so a model reads the same in every chart. */
export function modelColor(model: string): string {
  if (/sonnet/.test(model)) return "var(--series-1)";
  if (/opus/.test(model)) return "var(--series-2)";
  if (/haiku/.test(model)) return "var(--series-4)";
  if (/fable|mythos/.test(model)) return "var(--series-5)";
  return "var(--series-3)";
}

export function usdU(u: number): string {
  const usd = u / 1_000_000;
  return `$${usd.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

// ---------------------------------------------------------------------------
// Header: first prompt
// ---------------------------------------------------------------------------

export function StoryHeaderDetails({ story }: { story: SessionStory }) {
  return (
    <div className="story-header" data-testid="story-header">
      {story.transcript_available ? (
        story.first_prompt !== null && (
          <details className="story-prompt">
            <summary className="btn-secondary rec-disclosure">First prompt</summary>
            <p className="story-prompt-text" data-testid="story-first-prompt">
              {story.first_prompt}
            </p>
          </details>
        )
      ) : (
        <p className="section-meta" data-testid="story-no-transcript">
          Transcript no longer on disk, so the first prompt and files touched are unavailable.{" "}
          <InfoTip
            label="Why the transcript is missing"
            content="Claude Code deletes old transcripts (30 days by default; set cleanupPeriodDays in ~/.claude/settings.json to keep them longer). Turns, cost and errors stay in the dashboard's own database."
          />
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Where the money went
// ---------------------------------------------------------------------------

export function MoneyCard({ story }: { story: SessionStory }) {
  if (story.total_cost_u <= 0 || story.spend.length === 0) return null;
  const total = story.total_cost_u;
  return (
    <section className="sec" data-testid="money-card">
      <div className="sec-h">
        <h2>
          Where the money went{" "}
          <InfoTip
            label="What Where the money went shows"
            content="This session's estimated cost split by who ran each turn (the main conversation or a subagent) and which model it used. The biggest segment is where a change saves the most. Estimates use public API list prices, not your bill."
          />
        </h2>
        <span className="desc">
          <Chip kind="LIST_EQUIV" />
        </span>
      </div>
      <div className="card card-padded">
        {story.headline !== null && (
          <div className="money-headline">
            <p className="money-headline-text" data-testid="money-headline">
              {story.headline.text}
            </p>
            {story.headline.detail !== null && (
              <p className="section-meta">{story.headline.detail}</p>
            )}
            {story.headline.savings_u !== null && (
              <p className="money-savings" data-testid="money-savings">
                ≈ {usdU(story.headline.savings_u)} less (estimate){" "}
                <InfoTip
                  label="How the savings estimate works"
                  content="The same subagent tokens re-priced at Sonnet 5 list prices. It assumes the cheaper model would have used the same tokens, which it may not. Treat it as the size of the opportunity, not a promise."
                />
              </p>
            )}
          </div>
        )}
        <div
          className="money-bar"
          role="img"
          aria-label={`Cost split: ${story.spend
            .map(
              (s) =>
                `${s.chain === "main" ? "main" : "subagents"} ${prettyModel(s.model)} ${Math.round((s.cost_u / total) * 100)}%`,
            )
            .join(", ")}`}
        >
          {story.spend.map((s) => (
            <span
              key={`${s.chain}-${s.model}`}
              className={s.chain === "subagent" ? "money-seg money-seg-sub" : "money-seg"}
              style={{ width: `${(s.cost_u / total) * 100}%`, background: modelColor(s.model) }}
              title={`${s.chain === "main" ? "Main" : "Subagents"} · ${prettyModel(s.model)} · ${usdU(s.cost_u)}`}
            />
          ))}
        </div>
        <ul className="money-legend" data-testid="money-legend">
          {story.spend.map((s) => (
            <li key={`${s.chain}-${s.model}`}>
              <span
                className={s.chain === "subagent" ? "money-swatch money-seg-sub" : "money-swatch"}
                style={{ background: modelColor(s.model) }}
                aria-hidden="true"
              />
              {s.chain === "main" ? "Main" : "Subagents"} · {prettyModel(s.model)}
              <span className="section-meta">
                {" "}
                {usdU(s.cost_u)} · {Math.round((s.cost_u / total) * 100)}% · {s.turns} turns
              </span>
            </li>
          ))}
        </ul>
        <p className="kpi-fn">
          Striped segments are subagent turns; solid segments are the main conversation.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Full-session context and cost chart
// ---------------------------------------------------------------------------

interface ChartRow {
  idx: number;
  ts: string;
  lane: string;
  model: string;
  context: number;
  main: number | null;
  sub: number | null;
  cum_usd: number;
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ChartRow }>;
}) {
  const row = payload?.[0]?.payload;
  if (!active || row === undefined) return null;
  return (
    <div className="chart-tip">
      <div>
        Turn {row.idx} · {new Date(row.ts).toLocaleTimeString()}
      </div>
      <div>
        {row.lane} · {prettyModel(row.model)}
      </div>
      <div>Context {fmtTokens(row.context)}</div>
      <div>Spent so far ${row.cum_usd.toFixed(2)}</div>
    </div>
  );
}

type MarkerPoint = { cx?: number | undefined; cy?: number | undefined };

function Marker({
  cx,
  cy,
  kind,
}: {
  cx?: number | undefined;
  cy?: number | undefined;
  kind: "error" | "loop" | "test-fail" | "test-pass";
}) {
  if (cx === undefined || cy === undefined) return null;
  if (kind === "test-fail" || kind === "test-pass") {
    return (
      <polygon
        data-testid="story-chart-marker"
        data-kind={kind}
        points={`${cx},${cy - 4} ${cx + 4},${cy} ${cx},${cy + 4} ${cx - 4},${cy}`}
        fill={kind === "test-fail" ? "var(--text-muted)" : "var(--panel)"}
        stroke="var(--text-muted)"
        strokeWidth={1.5}
      />
    );
  }
  const color = kind === "error" ? "var(--red)" : "var(--amber)";
  return (
    <g data-testid="story-chart-marker" data-kind={kind}>
      <circle cx={cx} cy={cy} r={4} fill="var(--panel)" stroke={color} strokeWidth={1.5} />
      {kind === "error" ? (
        <path d={`M${cx - 2},${cy - 2}l4,4m0,-4l-4,4`} stroke={color} strokeWidth={1.5} />
      ) : (
        <circle cx={cx} cy={cy} r={1.5} fill={color} />
      )}
    </g>
  );
}

/**
 * Turn-axis ticks at a round step, about one per 100 px. Explicit ticks with `interval={0}` keep
 * recharts from measuring every label in the DOM to drop overlaps (M17 chart mount task).
 */
export function turnTicks(turns: number, width: number): number[] {
  const target = Math.max(2, Math.floor(width / 100));
  const raw = Math.max(1, turns / target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const ticks = [1];
  for (let t = step; t <= turns; t += step) if (t > 1) ticks.push(t);
  return ticks;
}

/**
 * Context per turn over every turn in the session, plus the running cost. Loop markers use the
 * breakdown's turn indices (same ts, message_id order); test markers come from the loaded turn
 * pages, matched by timestamp, so they cover only the turns loaded below.
 */
export function SessionContextCostChart({
  story,
  loadedTurns,
  loopTurnIndices,
}: {
  story: SessionStory;
  loadedTurns: TurnRow[];
  loopTurnIndices: number[];
}) {
  if (story.turns.length === 0) return null;
  const laneLabel = new Map(story.lanes.map((l) => [l.lane_id, l.label]));
  let cum = 0;
  const rows: ChartRow[] = story.turns.map((t, i) => {
    cum += t.cost_u;
    const isMain = t.lane_id === "main";
    return {
      idx: i + 1,
      ts: t.ts,
      lane: laneLabel.get(t.lane_id) ?? "Subagent",
      model: t.model,
      context: t.context,
      main: isMain ? t.context : null,
      sub: isMain ? null : t.context,
      cum_usd: cum / 1_000_000,
    };
  });
  const byTs = new Map<string, ChartRow>();
  for (const r of rows) if (!byTs.has(r.ts)) byTs.set(r.ts, r);
  const testRows = (kind: "fail" | "pass") =>
    loadedTurns.flatMap((t) => {
      const n = (kind === "fail" ? t.test_fail_events : t.test_pass_events) ?? 0;
      const row = byTs.get(t.ts);
      return n > 0 && row !== undefined ? [row] : [];
    });
  const testFails = testRows("fail");
  const testPasses = testRows("pass");
  const errorRows = rows.filter((_, i) => story.turns[i]?.error === true);
  const loopRows = [...new Set(loopTurnIndices)].flatMap((i) => (rows[i] ? [rows[i]] : []));
  const compactions = rows.filter((_, i) => story.turns[i]?.compaction === true);
  const hasSub = rows.some((r) => r.sub !== null);
  const hasMain = rows.some((r) => r.main !== null);

  return (
    <section className="sec" id="session-context-chart" data-testid="session-context-cost-chart">
      <div className="sec-h">
        <h2>
          Context and cost over the session{" "}
          <InfoTip
            label="What the context and cost chart shows"
            content="Context size for every turn (main and subagents are separate lines, since their contexts are independent) and a line for money spent so far. A steep cost line marks the expensive stretch; context near the red line is a reason to /clear or split the task."
          />
        </h2>
        <span className="desc">
          <Chip kind="OBS_PROXY" />
        </span>
      </div>
      <div className="card">
        <ChartAfterPaint height={220}>
          {(width) => (
            <ComposedChart
              width={width}
              height={220}
              data={rows}
              margin={{ top: 12, right: 8, bottom: 4, left: 0 }}
            >
              <CartesianGrid {...gridProps.grid} />
              <XAxis
                dataKey="idx"
                type="number"
                domain={[1, rows.length]}
                allowDecimals={false}
                axisLine={gridProps.axisLine}
                tickLine={gridProps.tickLine}
                ticks={turnTicks(rows.length, width)}
                interval={0}
                padding={{ left: 8, right: 8 }}
                tickFormatter={(v: number) => `Turn ${v}`}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                yAxisId="ctx"
                axisLine={gridProps.axisLine}
                tickLine={gridProps.tickLine}
                tickFormatter={fmtTokens}
                interval={0}
                width={48}
              />
              <YAxis
                yAxisId="usd"
                orientation="right"
                axisLine={gridProps.axisLine}
                tickLine={gridProps.tickLine}
                tickFormatter={(v: number) => `$${v.toFixed(v < 10 ? 1 : 0)}`}
                interval={0}
                width={48}
              />
              <NextTask>
                <Tooltip content={<ChartTooltip />} />
                {compactions.map((r) => (
                  <ReferenceLine
                    key={`c-${r.idx}`}
                    yAxisId="ctx"
                    x={r.idx}
                    stroke="var(--violet)"
                    strokeDasharray="4 4"
                  />
                ))}
                {hasMain && (
                  <Line
                    yAxisId="ctx"
                    type="linear"
                    dataKey="main"
                    name="Main context"
                    stroke={seriesPalette[0]}
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                )}
                {hasSub && (
                  <Line
                    yAxisId="ctx"
                    type="linear"
                    dataKey="sub"
                    name="Subagent context"
                    stroke="var(--violet)"
                    strokeWidth={1.5}
                    strokeDasharray="5 3"
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                )}
                <Line
                  yAxisId="usd"
                  type="stepAfter"
                  dataKey="cum_usd"
                  name="Spent so far"
                  stroke="var(--green)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                {errorRows.length > 0 && (
                  <Scatter
                    yAxisId="ctx"
                    data={errorRows}
                    dataKey="context"
                    name="Tool error"
                    shape={(p: MarkerPoint) => <Marker {...p} kind="error" />}
                    isAnimationActive={false}
                  />
                )}
                {loopRows.length > 0 && (
                  <Scatter
                    yAxisId="ctx"
                    data={loopRows}
                    dataKey="context"
                    name="Loop"
                    shape={(p: MarkerPoint) => <Marker {...p} kind="loop" />}
                    isAnimationActive={false}
                  />
                )}
                {testFails.length > 0 && (
                  <Scatter
                    yAxisId="ctx"
                    data={testFails}
                    dataKey="context"
                    name="Observed completed-test failure"
                    shape={(p: MarkerPoint) => <Marker {...p} kind="test-fail" />}
                    isAnimationActive={false}
                  />
                )}
                {testPasses.length > 0 && (
                  <Scatter
                    yAxisId="ctx"
                    data={testPasses}
                    dataKey="context"
                    name="Observed completed-test pass"
                    shape={(p: MarkerPoint) => <Marker {...p} kind="test-pass" />}
                    isAnimationActive={false}
                  />
                )}
              </NextTask>
              <ReferenceLine
                yAxisId="ctx"
                y={160_000}
                stroke="var(--red)"
                strokeDasharray="4 4"
                ifOverflow="extendDomain"
              />
            </ComposedChart>
          )}
        </ChartAfterPaint>
        <ul className="money-legend chart-legend" data-testid="story-chart-legend">
          <li className="section-meta">All {rows.length} turns</li>
          {hasMain && (
            <li>
              <i className="legend-line" style={{ background: seriesPalette[0] }} />
              Main context
            </li>
          )}
          {hasSub && (
            <li>
              <i className="legend-line legend-dashed" style={{ color: "var(--violet)" }} />
              Subagent context
            </li>
          )}
          <li>
            <i className="legend-line" style={{ background: "var(--green)" }} />
            Spent so far (right axis)
          </li>
          <li>
            <i className="legend-line legend-dashed" style={{ color: "var(--red)" }} />
            160K: 80% of the 200K context window
          </li>
          {compactions.length > 0 && (
            <li>dashed violet vertical: compaction ({compactions.length})</li>
          )}
          {errorRows.length > 0 && <li>red ⊗: tool error ({errorRows.length} turns)</li>}
          {loopRows.length > 0 && <li>amber ring: loop</li>}
          {(testFails.length > 0 || testPasses.length > 0) && (
            <li>◆/◇ observed test failure/pass (loaded turns only)</li>
          )}
        </ul>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Error groups
// ---------------------------------------------------------------------------

function ErrorGroupRow({ group, index }: { group: StoryErrorGroup; index: number }) {
  const [open, setOpen] = useState(false);
  const detailId = `error-group-${index}`;
  return (
    <Fragment>
      <tr data-testid="error-group-row">
        <td className="num">{group.count}</td>
        <td>
          {group.command !== null ? <code>{group.command}</code> : group.tool}
          {group.other_commands > 0 && (
            <span className="section-meta"> +{group.other_commands} others</span>
          )}
        </td>
        <td className="error-signature">{group.signature}</td>
        <td>
          <button
            type="button"
            className="btn-secondary"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide example" : "Show example"}
          </button>
        </td>
      </tr>
      {open && (
        <tr id={detailId}>
          <td colSpan={4}>
            <div className="inset-panel error-sample">
              {group.sample_command !== null && (
                <div className="cmd-row">{group.sample_command}</div>
              )}
              <pre className="error-sample-text">{group.sample_error}</pre>
              <p className="section-meta">
                {new Date(group.first_ts).toLocaleTimeString()} –{" "}
                {new Date(group.last_ts).toLocaleTimeString()}
              </p>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** Tool errors grouped by their stored text. Null when there is nothing grouped to show. */
export function ErrorGroupsPanel({
  story,
  toolErrorCount,
}: {
  story: SessionStory;
  /** The session's recorded tool-error total, so the grouped rows can say what share they cover. */
  toolErrorCount?: number;
}) {
  if (story.error_groups.length === 0) return null;
  const grouped = story.error_groups.reduce((s, g) => s + g.count, 0);
  const groups = story.error_groups.length;
  return (
    <section className="sec" data-testid="error-groups-panel">
      <div className="sec-h">
        <h2>
          What went wrong{" "}
          <InfoTip
            label="What the error groups show"
            content="Failed tool calls grouped by their error message. One cause, such as a hook blocking a command shape, often hits many commands, so each row names the most common command and how many others hit the same error. Fix the top row first."
          />
        </h2>
        <span className="desc section-meta" data-testid="error-groups-coverage">
          {toolErrorCount !== undefined && toolErrorCount > grouped
            ? `${groups === 1 ? "Top group" : `Top ${groups} groups`} · ${grouped} of ${toolErrorCount} tool errors`
            : `${grouped} tool error${grouped === 1 ? "" : "s"} in ${groups} group${groups === 1 ? "" : "s"}`}
          {story.errors_without_text > 0 &&
            ` · ${story.errors_without_text} older ${story.errors_without_text === 1 ? "error has" : "errors have"} no stored text; see the tool breakdown below`}
        </span>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Count</th>
                <th>Command</th>
                <th>Error</th>
                <th>Example</th>
              </tr>
            </thead>
            <tbody>
              {story.error_groups.map((g, i) => (
                <ErrorGroupRow key={`${g.tool}-${g.signature}`} group={g} index={i} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

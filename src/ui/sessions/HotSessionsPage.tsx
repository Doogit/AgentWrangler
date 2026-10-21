import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DiagnosticCategory } from "../../query/api/diagnostics";
import type {
  HotSessionPageRow,
  HotSessionPageSort,
  HotSessionsPageQuery,
} from "../../query/api/hot-sessions";
import type { HotSessionSortDirection } from "../../query/spend";
import { fetchHotSessionsPage } from "../api/client";
import { seedSessionHeader, sessionFirstReads } from "../api/drilldown-seed";
import { mockHotSessionsPage } from "../api/fixtures";
import { useInViewPrefetch, usePrefetchOnIntent } from "../api/prefetch";
import { queryClient } from "../api/query-client";
import { queryKeys } from "../api/query-keys";
import { coverageLabel, historyNoteText, useHistoryStatus } from "../lib/history-status";
import { relativeTime } from "../lib/relative-time";
import { shortId } from "../lib/short-id";
import { workspaceLabel } from "../lib/workspace-label";
import { useWorkspaceNames } from "../lib/workspace-names";
import AsyncErrorState from "../shell/AsyncErrorState";
import Chip from "../shell/Chip";
import EmptyState from "../shell/EmptyState";
import InfoTip from "../shell/InfoTip";
import { SkeletonRow } from "../shell/Skeleton";
import { SpendPercentileChip } from "./SpendPercentileChip";

type Query = {
  workspace?: string | undefined;
  model?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  category: DiagnosticCategory[];
  q?: string | undefined;
  range?: "all" | undefined;
  sort: HotSessionPageSort;
  direction: HotSessionSortDirection;
};
type QueryPatch = Partial<Omit<Query, "category" | "sort" | "direction">> & {
  category?: DiagnosticCategory[];
  sort?: HotSessionPageSort;
  direction?: HotSessionSortDirection;
};
type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ok";
      rows: HotSessionPageRow[];
      nextCursor: string | null;
      recentOnly?: boolean;
      refreshError?: boolean;
    };
const SORTS = new Set<HotSessionPageSort>([
  "cost",
  "output",
  "context",
  "turns",
  "last_active",
  "workspace",
  "issues",
  "subagent",
]);
const CATEGORY_COPY: Record<DiagnosticCategory, string> = {
  errors: "Errors",
  denials: "Denials",
  loops: "Loops",
  destructive_ops: "Destructive operations",
  token_waste: "Token waste",
};
// Type-only import above: diagnostics.ts pulls server code that can't enter the browser bundle.
const DIAGNOSTIC_CATEGORIES = Object.keys(CATEGORY_COPY) as DiagnosticCategory[];
const DRIVER_COPY: Record<string, string> = {
  CACHE_WRITE_CHURN: "Cache-write churn",
  LOOP_RETRY_WASTE: "Loop / retry waste",
  TOOL_RESULT_BLOAT: "Tool-result bloat",
  SESSION_LONG_FULL_CONTEXT: "Long session near context limit",
};
const TIPS = {
  issues:
    "What: attributed cost driver and diagnostic categories. Read: the dollar amount is this session's measured driver cost. Do: open the session to inspect the evidence.",
  cache:
    "What: cache-read tokens divided by all context tokens. Read: higher means more context was read from cache. Do: inspect the session's context pattern.",
  peak: "What: largest context in one turn and compaction count. Read: a high peak can approach the model limit. Do: inspect the context timeline.",
  share:
    "What: estimated cost of subagent and background calls in this session; the percentage is its share of total session cost. Read: a larger cost means more spend on those calls. Do: inspect the session breakdown.",
  perTurn:
    "What: whole-session estimated cost divided by turns. Read: higher values mean more spend per turn. Do: inspect expensive turns.",
  active:
    "What: summed short gaps between turns compared with elapsed first-to-last time. Read: long idle gaps increase wall time only. Do: inspect the session timeline.",
};
function subscribe(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}
function readQuery(hash: string): Query {
  const p = new URLSearchParams(hash.split("?")[1] ?? "");
  const sort = p.get("sort");
  const workspace = p.get("workspace");
  const model = p.get("model");
  const from = p.get("from");
  const to = p.get("to");
  const q = p.get("q");
  return {
    ...(workspace ? { workspace } : {}),
    ...(model ? { model } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(q ? { q } : {}),
    ...(p.get("range") === "all" ? { range: "all" as const } : {}),
    category: p
      .getAll("category")
      .flatMap((v) => v.split(","))
      .filter((v): v is DiagnosticCategory =>
        DIAGNOSTIC_CATEGORIES.includes(v as DiagnosticCategory),
      ),
    sort: SORTS.has(sort as HotSessionPageSort) ? (sort as HotSessionPageSort) : "cost",
    direction: p.get("direction") === "asc" ? "asc" : "desc",
  };
}
function writeQuery(query: Query) {
  const p = new URLSearchParams();
  if (query.workspace) p.set("workspace", query.workspace);
  if (query.model) p.set("model", query.model);
  if (query.range === "all") p.set("range", "all");
  if (query.from) p.set("from", query.from);
  if (query.to) p.set("to", query.to);
  for (const category of query.category) p.append("category", category);
  if (query.q) p.set("q", query.q);
  if (query.sort !== "cost" || query.direction !== "desc") {
    p.set("sort", query.sort);
    p.set("direction", query.direction);
  }
  const qs = p.toString();
  window.location.hash = `#/sessions${qs ? `?${qs}` : ""}`;
}
function money(value: number) {
  return `$${(value / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function ratio(n: number, d: number) {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : "—";
}
function duration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
/**
 * "claude-haiku-4-5-20251001" → "Haiku 4.5", "claude-3-5-sonnet-20241022" → "Sonnet 3.5"
 * (OV-11 item 19 / Q4). Ids that are not claude-* are shown unchanged.
 */
export function modelDisplayName(model: string): string {
  if (!model.startsWith("claude-")) return model;
  const parts = model
    .slice("claude-".length)
    .split("-")
    .filter((part) => !/^\d{8}$/.test(part));
  const words = parts.filter((part) => !/^\d+$/.test(part));
  const version = parts.filter((part) => /^\d+$/.test(part)).join(".");
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  return version === "" ? name : `${name} ${version}`;
}
function Header({ label, tip }: { label: string; tip: string }) {
  return (
    <th scope="col">
      {label} <InfoTip label={`What ${label} means`} content={tip} />
    </th>
  );
}

/** P1-U6a: the row link seeds the detail header on click and prefetches its first reads. */
function SessionLink({ row }: { row: HotSessionPageRow }) {
  const intent = usePrefetchOnIntent(() => sessionFirstReads(row.session_id));
  return (
    <a
      className="live-session-link"
      href={`#/sessions/${encodeURIComponent(row.session_id)}`}
      aria-label={`Open session ${row.session_id}`}
      title={row.title ?? row.session_id}
      {...intent}
      onClick={() =>
        seedSessionHeader({
          session_id: row.session_id,
          workspace_id: row.workspace_id,
          repo_owner: row.repo_owner,
          repo_name: row.repo_name,
          turn_count: row.turns,
          cost_equiv_u: row.cost_equiv_u,
          first_turn_at: row.first_turn_at ?? null,
          last_turn_at: row.last_turn_at,
        })
      }
    >
      <span className="session-title">{row.title || shortId(row.session_id)}</span>
    </a>
  );
}

export default function HotSessionsPage({
  onSelectSession,
}: { onSelectSession: (id: string) => void }) {
  void onSelectSession;
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "#/sessions",
  );
  const query = useMemo(() => readQuery(hash), [hash]);
  const [defaultFrom] = useState(() => new Date(Date.now() - 30 * 86_400_000).toISOString());
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [moreStatus, setMoreStatus] = useState<"idle" | "loading" | "error">("idle");
  const [search, setSearch] = useState(query.q ?? "");
  const [models, setModels] = useState<string[]>([]);
  const history = useHistoryStatus();
  const historyNote = historyNoteText(coverageLabel(history.coverage), history);
  const lastRevision = useRef(history.revision);
  const currentRevision = useRef(history.revision);
  currentRevision.current = history.revision;
  const listRequest = useRef(0);
  const request = useMemo<HotSessionsPageQuery>(
    () => ({
      ...(query.range === "all"
        ? {}
        : {
            window: {
              from: query.from ?? defaultFrom,
              ...(query.to !== undefined ? { to: query.to } : {}),
            } as { from: string; to: string },
          }),
      ...(query.workspace ? { workspace: query.workspace } : {}),
      ...(query.model ? { model: query.model } : {}),
      ...(query.category.length ? { category: query.category } : {}),
      ...(query.q ? { q: query.q } : {}),
      sort: query.sort,
      direction: query.direction,
    }),
    [query, defaultFrom],
  );
  const recentOnly = state.status === "ok" && state.recentOnly === true;
  useEffect(() => {
    setSearch(query.q ?? "");
  }, [query.q]);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/hot-sessions/models")
      .then(async (r) => {
        if (r.ok && !cancelled) {
          const value: unknown = await r.json();
          if (Array.isArray(value))
            setModels(value.filter((v): v is string => typeof v === "string"));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    void retry;
    const generation = ++listRequest.current;
    let cancelled = false;
    let fullTimer: ReturnType<typeof setTimeout> | undefined;
    // This load sees data as of now; only a later revision needs another fetch.
    lastRevision.current = currentRevision.current;
    setState({ status: "loading" });
    setMoreStatus("idle");
    const recentFrom = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const stageFrom =
      request.window?.from && request.window.from > recentFrom ? request.window.from : recentFrom;
    const canStage = (request.window?.to ?? "9999-12-31T23:59:59.999Z") > stageFrom;
    const full = () =>
      void Promise.resolve(fetchHotSessionsPage(request))
        .then((page) => {
          if (!cancelled && generation === listRequest.current)
            setState({ status: "ok", rows: page.rows, nextCursor: page.next_cursor });
        })
        .catch(() => {
          if (!cancelled && generation === listRequest.current)
            setState((previous) =>
              previous.status === "ok"
                ? { ...previous, refreshError: true }
                : import.meta.env.MODE === "test"
                  ? { status: "ok", rows: mockHotSessionsPage(request).rows, nextCursor: null }
                  : { status: "error" },
            );
        });
    if (canStage) {
      void Promise.resolve(
        fetchHotSessionsPage({
          ...request,
          window: { from: stageFrom, to: request.window?.to ?? "9999-12-31T23:59:59.999Z" },
          limit: 8,
        }),
      )
        .then((page) => {
          if (!cancelled && generation === listRequest.current)
            setState({ status: "ok", rows: page.rows, nextCursor: null, recentOnly: true });
        })
        .catch(() => {})
        .finally(() => {
          // Give React and the browser a frame to display the bounded recent result.
          if (!cancelled && generation === listRequest.current) fullTimer = setTimeout(full, 120);
        });
    } else full();
    return () => {
      cancelled = true;
      if (fullTimer !== undefined) clearTimeout(fullTimer);
    };
  }, [request, retry]);
  useEffect(() => {
    if (history.revision === lastRevision.current) return;
    // The first status is a baseline, not new data (the poller's own scope diff does the same).
    if (lastRevision.current === "pending") {
      lastRevision.current = history.revision;
      return;
    }
    // An in-flight load keeps the revision pending; the effect re-runs when it settles.
    if (state.status === "loading" || recentOnly) return;
    lastRevision.current = history.revision;
    const generation = ++listRequest.current;
    setMoreStatus("idle");
    let active = true;
    void fetchHotSessionsPage(request)
      .then((page) => {
        if (active && generation === listRequest.current)
          setState({ status: "ok", rows: page.rows, nextCursor: page.next_cursor });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [history.revision, request, state.status, recentOnly]);
  const { labelFor, options: workspaces } = useWorkspaceNames();
  // Read the live hash, not the rendered query: a second change can land before hashchange re-renders.
  function change(patch: QueryPatch) {
    writeQuery({ ...readQuery(window.location.hash), ...patch });
  }
  // P1-U6a: the next page, through a detail key so the in-view prefetch below is reused.
  function nextPageQuery(cursor: string) {
    return {
      queryKey: queryKeys.hotSessionsMore(JSON.stringify(request), cursor),
      queryFn: () => fetchHotSessionsPage({ ...request, cursor }),
    };
  }
  const nextCursor = state.status === "ok" ? state.nextCursor : null;
  const loadMoreRef = useInViewPrefetch(
    () => (nextCursor === null ? null : [nextPageQuery(nextCursor)]),
    `${JSON.stringify(request)}|${nextCursor}`,
  );
  async function loadMore() {
    if (state.status !== "ok" || state.nextCursor === null || moreStatus === "loading") return;
    const cursor = state.nextCursor;
    const generation = listRequest.current;
    setMoreStatus("loading");
    try {
      const page = await queryClient.fetchQuery(nextPageQuery(cursor));
      if (generation !== listRequest.current) return;
      setState((previous) =>
        previous.status === "ok" && previous.nextCursor === cursor
          ? {
              status: "ok",
              rows: [
                ...previous.rows,
                ...page.rows.filter(
                  (row) =>
                    !previous.rows.some((existing) => existing.session_id === row.session_id),
                ),
              ],
              nextCursor: page.next_cursor,
            }
          : previous,
      );
      setMoreStatus("idle");
    } catch {
      if (generation === listRequest.current) setMoreStatus("error");
    }
  }
  function sortBy(sort: HotSessionPageSort) {
    change({ sort, direction: query.sort === sort && query.direction === "desc" ? "asc" : "desc" });
  }
  const rows = state.status === "ok" ? state.rows : [];
  const maxCost = Math.max(1, ...rows.map((row) => row.cost_equiv_u));
  const modelOptions = [
    ...new Set([
      ...(query.model ? [query.model] : []),
      ...models,
      ...rows.flatMap((row) => (row.models.length ? row.models : [row.model])),
    ]),
  ].sort();
  const sortable = (label: string, sort: HotSessionPageSort, tip?: string) => (
    <th
      scope="col"
      aria-sort={
        query.sort === sort ? (query.direction === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        className={`sessions-sort-button${query.sort === sort ? " sessions-sort-button--active" : ""}`}
        aria-label={`Sort by ${label.toLowerCase()}`}
        onClick={() => sortBy(sort)}
      >
        {label}
        {query.sort === sort ? (query.direction === "asc" ? " ↑" : " ↓") : ""}
      </button>
      {tip && <InfoTip label={`What ${label} means`} content={tip} />}
    </th>
  );
  return (
    <>
      <div className="page-top">
        <div className="page-title">
          <h1>Sessions</h1>
          <p className="page-sub">
            {rows.length} sessions loaded
            {state.status === "ok" && state.nextCursor !== null ? " — more available" : ""}
            {state.status === "ok" && state.recentOnly
              ? " — recent seven days only; loading selected range"
              : ""}
            {historyNote !== null && (
              <>
                {" "}
                <span className="chip history-notice">{historyNote}</span>
              </>
            )}
          </p>
          {state.status === "ok" && state.refreshError && (
            <span role="alert">
              Could not load the selected range.{" "}
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setRetry((n) => n + 1)}
              >
                Retry
              </button>
            </span>
          )}
        </div>
      </div>
      {state.status === "error" ? (
        <AsyncErrorState resource="sessions" onRetry={() => setRetry((n) => n + 1)} />
      ) : (
        <>
          <div className="card">
            <div className="sessions-toolbar" aria-label="Session filters">
              <label className="sessions-filter-label">
                Workspace
                <select
                  className="sessions-dropdown"
                  value={query.workspace ?? ""}
                  onChange={(e) => change({ workspace: e.target.value || undefined })}
                >
                  <option value="">All workspaces</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sessions-filter-label">
                Model
                <select
                  className="sessions-dropdown"
                  value={query.model ?? ""}
                  onChange={(e) => change({ model: e.target.value || undefined })}
                >
                  <option value="">All models</option>
                  {modelOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sessions-filter-label">
                From
                <input
                  type="date"
                  value={query.from ?? ""}
                  onChange={(e) => change({ from: e.target.value || undefined, range: undefined })}
                />
              </label>
              <label className="sessions-filter-label">
                To
                <input
                  type="date"
                  value={query.to ?? ""}
                  onChange={(e) => change({ to: e.target.value || undefined, range: undefined })}
                />
              </label>
              <button
                type="button"
                className="btn-secondary"
                aria-pressed={query.range === "all"}
                onClick={() => change({ range: "all", from: undefined, to: undefined })}
              >
                All history
              </button>
              <fieldset className="sessions-category-chips">
                <legend>Category</legend>
                {DIAGNOSTIC_CATEGORIES.map((category) => (
                  <label key={category}>
                    <input
                      type="checkbox"
                      checked={query.category.includes(category)}
                      onChange={(e) => {
                        const current = readQuery(window.location.hash).category;
                        change({
                          category: e.target.checked
                            ? [...current, category]
                            : current.filter((c) => c !== category),
                        });
                      }}
                    />
                    {CATEGORY_COPY[category]}
                  </label>
                ))}
              </fieldset>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  change({ q: search.trim() || undefined });
                }}
              >
                <label className="sessions-filter-label">
                  Session ID
                  <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
                </label>
                <button type="submit" className="btn-secondary">
                  Search
                </button>
              </form>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setSearch("");
                  writeQuery({ category: [], sort: "cost", direction: "desc" });
                }}
              >
                Reset filters
              </button>
            </div>
          </div>
          <section className="sec" aria-labelledby="sessions-table-title">
            <div className="sec-h">
              <h2 id="sessions-table-title">Sessions by estimated cost</h2>
              <span className="desc">
                <Chip kind="LIST_EQUIV" />
              </span>
            </div>
            <div className="card card-padded">
              {state.status === "loading" ? (
                <div className="table-wrap" aria-busy="true" aria-label="Loading sessions">
                  <table>
                    <tbody>
                      <SkeletonRow cols={12} />
                    </tbody>
                  </table>
                </div>
              ) : rows.length === 0 && state.status === "ok" && state.recentOnly ? (
                <p>
                  No sessions in the recent seven days match these filters. Loading the selected
                  range.
                </p>
              ) : rows.length === 0 ? (
                <EmptyState
                  headline="No session cost data yet"
                  help={{
                    href: "#/help?topic=troubleshooting&section=missing-data",
                    label: "Help with missing history",
                  }}
                  why={
                    query.workspace !== undefined ||
                    query.model !== undefined ||
                    query.category.length > 0 ||
                    query.q !== undefined ||
                    query.from !== undefined ||
                    query.to !== undefined
                      ? "No sessions match these filters."
                      : "No sessions with recorded turns in this range."
                  }
                  whatWillAppear="Sessions with recorded turns will appear here."
                  command="claude"
                />
              ) : (
                <>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">#</th>
                          {sortable("Workspace", "workspace")}
                          {sortable(
                            "Estimated cost",
                            "cost",
                            "Estimated session cost at public API list prices, based on recorded token usage. This is not a bill.",
                          )}
                          <Header label="Cache hit %" tip={TIPS.cache} />
                          <Header label="Peak context" tip={TIPS.peak} />
                          {sortable("Subagent cost", "subagent", TIPS.share)}
                          <Header label="Cost/turn" tip={TIPS.perTurn} />
                          <Header label="Active / wall" tip={TIPS.active} />
                          <th scope="col">Models</th>
                          {sortable("Turns", "turns")}
                          {sortable("Issues", "issues", TIPS.issues)}
                          {sortable("Last active", "last_active")}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, index) => (
                          <tr key={row.session_id} className="hot-session-row">
                            <td>{index + 1}</td>
                            <td>
                              <a
                                className="hot-session-workspace-link"
                                href={`#/workspaces/${encodeURIComponent(row.workspace_id)}`}
                              >
                                {row.repo_owner && row.repo_name
                                  ? workspaceLabel({
                                      workspace_id: row.workspace_id,
                                      repo_owner: row.repo_owner,
                                      repo_name: row.repo_name,
                                    })
                                  : labelFor(row.workspace_id)}
                              </a>
                              <span aria-hidden="true"> · </span>
                              <SessionLink row={row} />
                            </td>
                            <td>
                              <div className="session-cost">
                                <span className="session-cost-figure">
                                  {money(row.cost_equiv_u)}
                                </span>
                                <span
                                  className="session-cost-bar"
                                  aria-label={`${Math.round((row.cost_equiv_u / maxCost) * 100)}% of highest session cost`}
                                  style={{
                                    width: `${Math.max((row.cost_equiv_u / maxCost) * 100, 2)}%`,
                                  }}
                                />
                                <SpendPercentileChip
                                  percentile={row.spend_percentile}
                                  n={row.spend_percentile_n}
                                />
                              </div>
                            </td>
                            <td>{ratio(row.sum_cache_read_tokens, row.total_context_tokens)}</td>
                            <td>
                              {row.max_context_tokens.toLocaleString()}
                              {row.compaction_count > 0
                                ? ` · ${row.compaction_count} ${row.compaction_count === 1 ? "compaction" : "compactions"}`
                                : ""}
                            </td>
                            <td>
                              {money(row.sidechain_cost_u)} ·{" "}
                              {ratio(row.sidechain_cost_u, row.cost_equiv_u)}
                            </td>
                            <td>{row.turns > 0 ? money(row.cost_equiv_u / row.turns) : "—"}</td>
                            <td>
                              {row.active_time_s > 0 && row.wall_time_s > 0
                                ? `${duration(row.active_time_s)} of ${duration(row.wall_time_s)}`
                                : "—"}
                            </td>
                            <td>
                              <div className="session-models-line">
                                {[
                                  row.model,
                                  ...(row.models.length ? row.models : [row.model]).filter(
                                    (model) => model !== row.model,
                                  ),
                                ].map((model, index) => (
                                  <span key={model} title={`Model: ${model}`}>
                                    {index > 0 && ", "}
                                    {modelDisplayName(model)}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td>{row.turns.toLocaleString()}</td>
                            <td>
                              {row.issues.top_driver || row.issues.categories.length > 0 ? (
                                <div className="session-issue-chips">
                                  {row.issues.top_driver && (
                                    <span
                                      className="chip chip-plain"
                                      title={`${money(row.issues.top_driver.session_cost_u)} spent on this in this session`}
                                    >
                                      {DRIVER_COPY[row.issues.top_driver.label] ??
                                        row.issues.top_driver.label}
                                    </span>
                                  )}
                                  {row.issues.categories.map((category) => (
                                    <span key={category} className="chip chip-plain">
                                      {CATEGORY_COPY[category]}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td title={row.last_turn_at}>{relativeTime(row.last_turn_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {state.nextCursor !== null &&
                    (moreStatus === "error" ? (
                      <div role="alert">
                        Couldn't load more sessions{" "}
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => void loadMore()}
                        >
                          Retry
                        </button>
                      </div>
                    ) : (
                      <button
                        ref={loadMoreRef}
                        type="button"
                        className="btn-secondary"
                        disabled={moreStatus === "loading"}
                        onClick={() => void loadMore()}
                      >
                        {moreStatus === "loading" ? "Loading…" : "Load more"}
                      </button>
                    ))}
                </>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}

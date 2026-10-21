/**
 * The session page's "at a glance" row (session details + files edited) and the
 * "Investigate this session" prompt card.
 */
import { useState } from "react";
import type { SessionSummary } from "../../query/api/overview";
import type { SessionStory } from "../../query/api/session-story";
import Chip from "../shell/Chip";
import InfoTip from "../shell/InfoTip";
import type { PanelState } from "./SessionPanels";
import { SignalRows } from "./SignalRows";

const HYGIENE_FLAG_LABEL: Record<string, string> = {
  LONG_FULL_CONTEXT: "Long session near context limit",
  NO_BASH_EVENTS: "No shell activity",
};

function when(ts: string | null): string {
  return ts === null ? "N/A" : new Date(ts).toLocaleString();
}

function Fact({
  label,
  tip,
  children,
  testId,
}: {
  label: string;
  tip: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="fact">
      <dt>
        {label} <InfoTip label={`What ${label} shows`} content={tip} />
      </dt>
      <dd data-testid={testId}>{children}</dd>
    </div>
  );
}

export function SessionFactsCard({
  session,
  story,
}: {
  session: SessionSummary;
  story: SessionStory | null;
}) {
  return (
    <section className="sec" data-testid="session-facts">
      <div className="sec-h">
        <h2>
          Session details{" "}
          <InfoTip
            label="What Session details shows"
            content="When the session ran, what it committed, and structural flags worth checking. Context for the cost and error sections below, not a score."
          />
        </h2>
      </div>
      <div className="card card-padded">
        <dl className="fact-grid">
          <Fact
            label="Started"
            tip="Local time of the first observed turn. Context for the other metrics — not good or bad on its own."
          >
            {when(session.first_turn_at)}
          </Fact>
          <Fact
            label="Last turn"
            tip="Local time of the most recent observed turn. A recent time can mean the session is still active."
          >
            {when(session.last_turn_at)}
          </Fact>
          <Fact
            label="Commits"
            tip="Commits this session made, read from its git activity. Hover a SHA for its time."
            testId="story-commits"
          >
            {story === null ? (
              "—"
            ) : story.commits.length === 0 ? (
              "None observed"
            ) : (
              <span className="fact-codes">
                {story.commits.map((c) => (
                  <code key={c.sha} title={`${c.sha} · ${new Date(c.ts).toLocaleString()}`}>
                    {c.sha.slice(0, 7)}
                  </code>
                ))}
              </span>
            )}
          </Fact>
          <Fact
            label="Turns through first commit"
            tip="The number of main-conversation turns through the first commit. Empty when this session made no commit. This counts turns, not the quality of the result."
            testId="turns-to-first-commit"
          >
            {session.turns_to_first_commit !== undefined
              ? session.turns_to_first_commit !== null
                ? String(session.turns_to_first_commit)
                : "—/no commit"
              : "—"}
          </Fact>
          <Fact
            label="Hygiene flags"
            tip="Structural signals about the session, such as a long session near the context limit. They flag conditions worth checking, not errors or a quality score."
          >
            {session.hygiene_flags.length > 0 ? (
              <span className="fact-codes">
                {session.hygiene_flags.map((f) => (
                  <span key={f} className="chip chip-plain chip-wrap">
                    {HYGIENE_FLAG_LABEL[f] ?? f}
                  </span>
                ))}
              </span>
            ) : (
              "None"
            )}
          </Fact>
          <Fact
            label="Edits without a commit"
            tip="Shown for a reconciled session with at least 10 user turns, Bash/Write/Edit/NotebookEdit activity, and no observed commit. This is an activity cohort, not abandonment or a judgment about usefulness."
            testId="deep-abandoned"
          >
            {session.deep_abandoned === true ? (
              <Chip kind="DIRECTIONAL" label="DEEP ACTIVITY, NO OBSERVED COMMIT" />
            ) : (
              "No"
            )}
          </Fact>
        </dl>
      </div>
    </section>
  );
}

/** "C:/a/b/c/d.ts" → "…/c/d.ts"-style trailing dirs; repo-relative paths keep their full dir. */
export function splitPath(path: string): { dir: string; name: string; outside: boolean } {
  const p = path.replaceAll("\\", "/");
  const outside = /^([A-Za-z]:\/|\/|~\/)/.test(p);
  const parts = p.split("/").filter(Boolean);
  const name = parts.pop() ?? p;
  const dirs = outside && parts.length > 2 ? ["…", ...parts.slice(-2)] : parts;
  return { dir: dirs.length > 0 ? `${dirs.join("/")}/` : "", name, outside };
}

function ext(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).slice(0, 4) : "file";
}

const STAT_KEYS = ["a", "b", "c", "d", "e"];
const STAT_CELLS = STAT_KEYS.length;

function FileRow({ path, edits, max }: { path: string; edits: number; max: number }) {
  const { dir, name } = splitPath(path);
  const filled = Math.max(1, Math.round((edits / max) * STAT_CELLS));
  return (
    <li className="file-row" title={path}>
      <span className="file-ext" aria-hidden="true">
        {ext(name)}
      </span>
      <span className="file-path">
        <span className="file-name">{name}</span>
        {dir !== "" && (
          <span className="file-dir">
            <bdi>{dir}</bdi>
          </span>
        )}
      </span>
      <span className="file-stat">
        <span className="file-cells" aria-hidden="true">
          {STAT_KEYS.map((k, i) => (
            <i key={k} className={i < filled ? "on" : undefined} />
          ))}
        </span>
        <span className="file-count" title={`${edits} edits`}>
          {edits}
          <span className="sr-only"> edits</span>
        </span>
      </span>
    </li>
  );
}

export function FilesEditedCard({ story }: { story: SessionStory | null }) {
  const files = story?.files_touched ?? [];
  const inside = files.filter((f) => !splitPath(f.path).outside);
  const outside = files.filter((f) => splitPath(f.path).outside);
  const max = files.reduce((m, f) => Math.max(m, f.edits), 1);
  const total = files.reduce((s, f) => s + f.edits, 0);
  return (
    <section className="sec" data-testid="files-edited">
      <div className="sec-h">
        <h2>
          Files edited{" "}
          <InfoTip
            label="What Files edited shows"
            content="Files this session changed with Edit, Write or NotebookEdit, read from the transcript, with how many edits each got (top 15). The bar is relative to the most-edited file. Many edits to one file can mean rework; files outside the repo are usually scratch files."
          />
        </h2>
        {files.length > 0 && (
          <span className="desc section-meta">
            {files.length} files · {total} edits
          </span>
        )}
      </div>
      <div className="card card-padded">
        {story === null ? (
          <p className="section-meta">Unavailable — the session story did not load.</p>
        ) : !story.transcript_available ? (
          <p className="section-meta">Transcript no longer on disk, so edits can't be read.</p>
        ) : files.length === 0 ? (
          <p className="section-meta">No file edits observed.</p>
        ) : (
          <>
            {inside.length > 0 && (
              <ul className="file-list" data-testid="story-files">
                {inside.map((f) => (
                  <FileRow key={f.path} path={f.path} edits={f.edits} max={max} />
                ))}
              </ul>
            )}
            {outside.length > 0 && (
              <>
                <p className="file-group">Outside the repo</p>
                <ul className="file-list" data-testid="story-files-outside">
                  {outside.map((f) => (
                    <FileRow key={f.path} path={f.path} edits={f.edits} max={max} />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function InvestigateCard({ prompt, loading }: { prompt: string; loading: boolean }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  function onCopy() {
    const write = navigator.clipboard?.writeText(prompt);
    if (write === undefined) {
      setStatus("failed");
      return;
    }
    void write.then(
      () => setStatus("copied"),
      () => setStatus("failed"),
    );
    setTimeout(() => setStatus("idle"), 2000);
  }
  return (
    <section className="sec" data-testid="investigate-card">
      <div className="sec-h">
        <h2>
          Investigate this session{" "}
          <InfoTip
            label="What the investigate prompt does"
            content="A ready-made prompt for Claude or another agent: where to find this session's transcript, what it cost and why, what went wrong, and what to look into. Paste it into a new session; the agent checks each claim against the transcript before proposing changes. The text stays on your machine until you paste it."
          />
        </h2>
      </div>
      <div className="card card-padded">
        <p className="section-meta" style={{ marginTop: 0 }}>
          Hand this session to an agent to explain its cost, find ways to spend less, and trace its
          errors. It copies exactly the text below.
        </p>
        <pre className="rec-copy-preview investigate-preview" data-testid="investigate-prompt-text">
          {prompt}
        </pre>
        <button
          type="button"
          className="btn-primary"
          onClick={onCopy}
          disabled={loading}
          aria-live="polite"
          data-testid="copy-investigate-prompt"
        >
          {loading
            ? "Loading session data…"
            : status === "copied"
              ? "Copied"
              : status === "failed"
                ? "Copy failed — copy the text above by hand"
                : "Copy prompt"}
        </button>
      </div>
    </section>
  );
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

const TEST_SEQUENCE: Record<NonNullable<SessionSummary["test_outcome"]>, string> = {
  FAILED_THEN_PASSED: "Tests failed, then passed later",
  FAILURES_OBSERVED: "Tests failed; no later pass seen",
  NO_FAILURES_OBSERVED: "Tests passed; no failures",
  NO_TEST_OUTCOMES: "No completed tests",
};

function testSequence(session: SessionSummary): string {
  const outcome = session.test_outcome ?? "NO_TEST_OUTCOMES";
  // No failures is not a pass: runs that crashed or errored also have no TEST_FAIL.
  if (outcome === "NO_FAILURES_OBSERVED" && (session.test_pass_count ?? 0) === 0) {
    return "Tests ran; no failures seen";
  }
  return TEST_SEQUENCE[outcome];
}

const LOOK = { level: "Look", tone: "amber", rank: 0 } as const;
const OK = { level: "OK", tone: "green", rank: 2 } as const;

export interface TurnPricing {
  priced_turn_count: number;
  unpriced_turn_count: number;
}

/**
 * Facts no other section states: how many turns are priced (the $ figures leave unpriced turns
 * out), the test sequence in words (same session fields as Friction, so the two cannot disagree),
 * and where the tool errors are explained.
 */
export function ObservedEvidenceCard({
  session,
  pricing,
  errorGroupsShown = true,
  onRetry,
}: {
  session: SessionSummary;
  pricing: PanelState<TurnPricing | null>;
  /** Whether the What went wrong section is on the page, so the card can point at it. */
  errorGroupsShown?: boolean;
  onRetry: () => void;
}) {
  const value = pricing.status === "ok" ? pricing.value : null;
  const unpriced = value?.unpriced_turn_count ?? 0;
  const finished = value === null ? 0 : value.priced_turn_count + value.unpriced_turn_count;
  // The counts cover finished turns only; say how many in-progress (provisional) turns are left out.
  const inProgress = value === null ? 0 : Math.max(0, session.turn_count - finished);
  return (
    <section className="sec" data-testid="session-observed-evidence">
      <div className="sec-h">
        <h2>
          Observed evidence{" "}
          <InfoTip
            label="What Observed evidence shows"
            content="Facts read straight from this session's recorded turns and tool calls, not a judgement of how it went. Use them to check the cost and test figures before acting on them."
          />
        </h2>
      </div>
      <div className="card card-padded">
        <SignalRows
          rows={[
            {
              label: "Priced turns",
              valueTestId: "observed-priced-turns",
              value:
                pricing.status === "loading"
                  ? "Loading…"
                  : value !== null && finished === 0
                    ? "In progress"
                    : value !== null
                      ? `${value.priced_turn_count.toLocaleString("en-US")} of ${finished.toLocaleString("en-US")}`
                      : "Unavailable",
              ...(value === null || finished === 0 ? { rank: 1 } : unpriced > 0 ? LOOK : OK),
              found: (
                <>
                  {pricing.status === "loading"
                    ? "Checking price coverage…"
                    : pricing.status === "error"
                      ? "Price coverage failed to load."
                      : value === null
                        ? "Price coverage is not available for this session."
                        : unpriced > 0
                          ? `${plural(unpriced, "turn")} ${unpriced === 1 ? "has no price; its" : "have no price; their"} cost is not in the $ figures.`
                          : finished > 0
                            ? "Every finished turn has a price."
                            : "No turn has finished yet."}
                  {inProgress > 0 &&
                    ` ${plural(inProgress, "turn")} still in progress ${inProgress === 1 ? "is" : "are"} not counted here yet.`}
                </>
              ),
              why: "An unpriced turn adds nothing to the $ figures on this page, so the real cost is higher when any are unpriced. It is usually a model missing from the price table.",
            },
            {
              label: "Test sequence",
              valueTestId: "observed-test-sequence",
              value: testSequence(session),
              ...(session.test_outcome === "FAILURES_OBSERVED" ? LOOK : OK),
              found:
                session.test_fail_count > 0
                  ? `${plural(session.test_fail_count, "test failure signal")} recorded.`
                  : session.test_outcome === "FAILURES_OBSERVED"
                    ? "Failed test runs were seen, with no later pass."
                    : "No failed tests recorded.",
              why: "Failed, then passed later is the healthy pattern. Failures with no later pass can mean the session ended with broken tests, so check them before trusting the work. It uses the same records as Friction signals.",
            },
            {
              label: "Tool errors",
              value: session.tool_error_count.toLocaleString("en-US"),
              ...(session.tool_error_count > 0 ? LOOK : OK),
              found:
                session.tool_error_count === 0
                  ? "No tool errors recorded."
                  : errorGroupsShown
                    ? `${plural(session.tool_error_count, "tool error")}: see What went wrong above for them grouped by message.`
                    : `${plural(session.tool_error_count, "tool error")} recorded.`,
              why: "Each failed tool call wastes a turn and re-sends context. Fix the most repeated error first; it usually has one cause.",
            },
          ]}
        />
        {/* Outside the rows: a button inside <summary> is nested interactive content. */}
        {pricing.status === "error" && (
          <button type="button" className="btn-secondary signal-retry" onClick={onRetry}>
            Retry price coverage
          </button>
        )}
      </div>
    </section>
  );
}

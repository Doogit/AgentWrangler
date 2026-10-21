import { useEffect, useRef, useState } from "react";
import type { JudgeVerdict } from "../../judge/verdict";
import type { JudgeBlock } from "../../query/api/judge-payload";
import InfoTip from "../shell/InfoTip";
import JudgeConsent from "./JudgeConsent";
import JudgeNarrative, { type NarrativeCheck } from "./JudgeNarrative";
import {
  type ReadyConsent,
  type StoredVerdict,
  approveConsent,
  cancelJudge,
  fetchConsent,
  fetchStoredVerdict,
  revokeConsent,
  runJudge,
  saveSources,
} from "./judge-api";
import { BLOCK_CLASS_LABEL, FAILURE_COPY } from "./narrative";

type Phase =
  | { k: "idle" }
  | { k: "preparing" }
  | { k: "consent"; view: ReadyConsent; notice: string | null }
  | { k: "blocked"; blocked: JudgeBlock[] }
  | { k: "running" }
  | { k: "failed"; code: string };

type Stored =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; verdict: StoredVerdict | null };

const CONFIG_CHANGED =
  "Your config changed since this screen was shown (or it was open for over 10 minutes). Review what will be sent again.";
const APPROVE_AGAIN = "Approve this review to send it.";

function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  return m ? `Claude ${m[1]?.charAt(0).toUpperCase()}${m[1]?.slice(1)} ${m[2]}.${m[3]}` : id;
}

/** "Written review": the Judge me flow and the stored AI opinion (plan U10). */
export default function JudgeReview({
  checks,
  activeCaps,
  onVerdict,
}: {
  checks: ReadonlyMap<string, NarrativeCheck>;
  activeCaps: ReadonlyMap<string, string>;
  onVerdict: (verdict: JudgeVerdict | null) => void;
}) {
  const [stored, setStored] = useState<Stored>({ status: "loading" });
  const [remembered, setRemembered] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [announce, setAnnounce] = useState("");
  const [reload, setReload] = useState(0);
  const [refocus, setRefocus] = useState(0);
  const busy = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const onVerdictRef = useRef(onVerdict);
  onVerdictRef.current = onVerdict;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is an intentional re-fetch trigger
  useEffect(() => {
    let cancelled = false;
    fetchStoredVerdict()
      .then((r) => {
        if (cancelled) return;
        setStored({ status: "ok", verdict: r.verdict });
        setRemembered(r.remembered);
        onVerdictRef.current(r.verdict?.verdict ?? null);
      })
      .catch(() => {
        if (!cancelled) setStored({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  // The trigger was disabled while the consent view loaded, so the dialog may not have captured it; runs after
  // the dialog's own unmount cleanup.
  useEffect(() => {
    if (refocus > 0) trigger.current?.focus();
  }, [refocus]);

  const fail = (code: string) => {
    setPhase({ k: "failed", code });
    setAnnounce(FAILURE_COPY[code] ?? FAILURE_COPY.network ?? "");
  };

  async function start(notice: string | null = null) {
    if (busy.current) return;
    setPhase({ k: "preparing" });
    setAnnounce("Preparing what will be sent…");
    let view: Awaited<ReturnType<typeof fetchConsent>>;
    try {
      view = await fetchConsent();
    } catch {
      fail("network");
      return;
    }
    if (view.state === "blocked") {
      setPhase({ k: "blocked", blocked: view.blocked });
      setAnnounce("Not sent: a secret was found in your setup.");
      return;
    }
    if (view.standing && notice === null) {
      await run(view.shapeHash, null);
      return;
    }
    setPhase({ k: "consent", view, notice });
    setAnnounce("");
  }

  async function run(shapeHash: string, nonce: string | null) {
    if (busy.current) return;
    busy.current = true;
    const ac = new AbortController();
    abort.current = ac;
    setPhase({ k: "running" });
    setAnnounce("Sending your setup to Claude. This takes about a minute.");
    let r: Awaited<ReturnType<typeof runJudge>> | null = null;
    try {
      r = await runJudge(shapeHash, nonce, ac.signal);
    } catch {
      r = null;
    }
    busy.current = false;
    if (ac.signal.aborted) return; // cancel() already set the state
    abort.current = null;
    if (r === null) return fail("network");
    const error = typeof r.body.error === "string" ? r.body.error : "";
    if (r.status === 200) {
      const v = r.body as unknown as StoredVerdict;
      setStored({ status: "ok", verdict: v });
      onVerdictRef.current(v.verdict);
      setPhase({ k: "idle" });
      setAnnounce("The review is ready.");
    } else if (r.status === 403) {
      await start(APPROVE_AGAIN);
    } else if (r.status === 409 && error !== "in_flight") {
      await start(CONFIG_CHANGED);
    } else if (r.status === 422) {
      setPhase({ k: "blocked", blocked: (r.body.blocked as JudgeBlock[] | undefined) ?? [] });
    } else {
      fail(error in FAILURE_COPY ? error : "network");
    }
  }

  async function approve(view: ReadyConsent, remember: boolean) {
    setPhase({ k: "preparing" });
    const r = await approveConsent(view.shapeHash, remember).catch(() => null);
    if (r === null) return fail("network");
    if (r.status === 409 || r.status === 422) return start(CONFIG_CHANGED);
    const nonce = typeof r.body.consentNonce === "string" ? r.body.consentNonce : null;
    if (r.status !== 200 || nonce === null) return fail("network");
    if (remember) setRemembered(true);
    await run(view.shapeHash, nonce);
  }

  function cancel() {
    abort.current?.abort();
    abort.current = null;
    busy.current = false;
    void cancelJudge().catch(() => {});
    fail("cancelled");
  }

  async function saveAndReload(names: string[], repos: string[]): Promise<boolean> {
    const r = await saveSources(names, repos).catch(() => null);
    if (r === null || r.status !== 200) return false;
    const view = await fetchConsent().catch(() => null);
    if (view === null) return false;
    if (view.state === "blocked") setPhase({ k: "blocked", blocked: view.blocked });
    else setPhase({ k: "consent", view, notice: null });
    return true;
  }

  const verdict = stored.status === "ok" ? stored.verdict : null;
  const working = phase.k === "preparing" || phase.k === "running";
  const label =
    phase.k === "running"
      ? "Judging…"
      : phase.k === "preparing"
        ? "Preparing…"
        : verdict
          ? "Judge me again"
          : "Judge me";

  return (
    <section className="sec judge-narrative" aria-labelledby="judge-narrative-title">
      <div className="sec-h">
        <h2 id="judge-narrative-title">Written review</h2>
        {verdict?.outdated && (
          <span className="desc">
            <span className="chip chip-plain">Outdated</span>{" "}
            <InfoTip
              label="What outdated means"
              content="Your grade changed after this review was written, so some of it may no longer apply. Click Judge me again for a fresh review."
            />
          </span>
        )}
      </div>
      <div className="card card-padded judge-review">
        <div className="judge-review-head">
          <p className="judge-review-intro">
            Ask Claude to read a summary of your setup and say what the checks above miss. You see
            exactly what is sent before anything leaves this machine. It takes about a minute and
            uses roughly $0.30–$0.40 of your Claude usage{" "}
            <InfoTip
              label="What the review costs"
              content="Each review is one Claude Code request on your own login, on the model shown on the consent screen. The figure is the typical cost Claude Code reports for one review; it counts toward your plan's usage limits, not a separate bill. Nothing runs unless you click Send."
            />
            .
          </p>
          <div className="judge-review-actions">
            <button
              ref={trigger}
              type="button"
              className="btn-primary"
              disabled={working}
              onClick={() => void start()}
            >
              {label}
            </button>
            {phase.k === "running" && (
              <button type="button" className="btn-secondary" onClick={cancel}>
                Cancel review
              </button>
            )}
            {remembered && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  void revokeConsent().then((r) => {
                    if (r.status === 200) {
                      setRemembered(false);
                      setAnnounce("The consent screen will show before every review.");
                    }
                  });
                }}
              >
                Always ask before sending
              </button>
            )}
          </div>
        </div>

        <output aria-live="polite" className="judge-review-status">
          {announce}
        </output>

        {phase.k === "failed" && (
          <div className="judge-review-failed">
            <button type="button" className="btn-secondary" onClick={() => void start()}>
              Retry
            </button>
          </div>
        )}

        {phase.k === "blocked" && (
          <div className="judge-banner judge-review-blocked" role="alert">
            <p>Nothing was sent. Your setup contains what looks like a secret:</p>
            <ul>
              {phase.blocked.map((b) => (
                <li key={`${b.source}:${b.match_class}`}>
                  {BLOCK_CLASS_LABEL[b.match_class] ?? "a secret"} in <code>{b.source}</code>
                </li>
              ))}
            </ul>
            <p>
              Remove or move the secret out of that file (for example into an environment variable),
              then click {label}.
            </p>
          </div>
        )}

        {stored.status === "error" && (
          <div className="judge-review-failed">
            <p>Could not load the saved review.</p>
            <button type="button" className="btn-secondary" onClick={() => setReload((n) => n + 1)}>
              Retry loading the review
            </button>
          </div>
        )}

        {verdict && (
          <>
            <p className="judge-review-meta">
              Written by {modelName(verdict.model)} on{" "}
              {new Date(verdict.created_at).toLocaleDateString(undefined, { dateStyle: "medium" })}
              {verdict.cost_usd !== null && (
                <>
                  {" "}
                  · cost ${verdict.cost_usd.toFixed(2)}{" "}
                  <InfoTip
                    label="What the review cost means"
                    content="What Claude Code reported this review cost on your login. It counts toward your plan's usage, not a separate bill."
                  />
                </>
              )}
            </p>
            <JudgeNarrative verdict={verdict.verdict} checks={checks} activeCaps={activeCaps} />
          </>
        )}
      </div>

      {phase.k === "consent" && (
        <JudgeConsent
          view={phase.view}
          notice={phase.notice}
          onApprove={(remember) => void approve(phase.view, remember)}
          onDecline={() => {
            setPhase({ k: "idle" });
            setAnnounce("Not sent.");
            setRefocus((n) => n + 1);
          }}
          onSaveSources={saveAndReload}
        />
      )}
    </section>
  );
}

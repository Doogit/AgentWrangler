/**
 * src/ui/recommendations/PracticesSection.tsx — BM1 published-practice scorecard.
 *
 * Self-fetching component that renders the /api/practices response as a table
 * of rows. Each row shows: status chip · practice statement · optional DIRECTIONAL
 * chip for trend-only entries · cited source link + date · threshold InfoTip ·
 * optional deep-link to an existing artifact.
 *
 * §0.5.1 parity bar: ZERO authored advice sentences. The component renders only
 * practice_statement (verbatim from the registry), status, and citation metadata.
 *
 * SEC-101: no transcript content — every field is static registry metadata
 * (counts, URLs, dates, statuses).
 */

import { useEffect, useState } from "react";
import type {
  PracticeEntry,
  PracticeStatus,
  PracticesResult,
} from "../../detector/practice-registry";
import { fetchPractices } from "../api/client";
import Chip from "../shell/Chip";
import InfoTip from "../shell/InfoTip";
import { SkeletonBlock } from "../shell/Skeleton";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: PracticesResult };

function statusKind(status: PracticeStatus): "PASS" | "ATTENTION" | "NO_DATA" {
  return status;
}

function PracticeRow({ practice }: { practice: PracticeEntry }) {
  const isDirectional = practice.threshold.value === null;
  // artifact_link is e.g. "/recommendations"; hash route is "#/recommendations"
  const hashLink = practice.artifact_link !== null ? `#${practice.artifact_link}` : null;

  return (
    <div
      className="practice-row"
      data-status={practice.status}
      data-practice-id={practice.practice_id}
    >
      <div className="practice-status">
        <Chip kind={statusKind(practice.status)} />
      </div>
      <div className="practice-body">
        <span className="practice-statement">{practice.statement}</span>
        {isDirectional && (
          <span className="practice-directional">
            {" "}
            <Chip kind="DIRECTIONAL" />
          </span>
        )}
        {hashLink !== null && (
          <span className="practice-artifact-link">
            {" "}
            <a href={hashLink} className="practice-open-link">
              Open ↗
            </a>
          </span>
        )}
      </div>
      <div className="practice-citation">
        <a
          href={practice.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="practice-source-link"
        >
          {practice.source_date}
        </a>{" "}
        <Chip kind="VERIFIED_SOURCE" />{" "}
        <InfoTip
          label={`Threshold for ${practice.practice_id}`}
          content={practice.threshold.rationale}
        />
      </div>
    </div>
  );
}

export default function PracticesSection() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchPractices()
      .then((v) => {
        if (!cancelled) setState({ status: "ok", value: v });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ status: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <div className="practices-section" aria-busy="true" aria-label="Loading practices">
        <SkeletonBlock />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="practices-section">
        <div className="banner banner-error" role="alert">
          <span>Practices unavailable: {state.message}</span>
        </div>
      </div>
    );
  }

  const { practices } = state.value;

  return (
    <div className="practices-section">
      {practices.map((practice) => (
        <PracticeRow key={practice.practice_id} practice={practice} />
      ))}
    </div>
  );
}

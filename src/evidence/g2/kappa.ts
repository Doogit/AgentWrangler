export type JudgeLabel = "CONFIRMED" | "REJECTED";

export const G2_KAPPA_GATE = 0.6;

// Minimum human-seed size for a meaningful κ calibration. Below this, κ is too
// noisy to anchor on (a single agreeing pair yields κ=1), so the pipeline
// refuses rather than auto-labeling on a degenerate seed.
export const G2_MIN_SEED_N = 8;

export interface KappaResult {
  n: number;
  rawAgreement: number;
  kappa: number;
}

export function cohenKappa(a: readonly JudgeLabel[], b: readonly JudgeLabel[]): KappaResult {
  if (a.length !== b.length) {
    throw new Error("Judge label arrays must have the same length.");
  }

  if (a.length === 0) {
    throw new Error("Judge label arrays must not be empty.");
  }

  let agreements = 0;
  let aConfirmed = 0;
  let bConfirmed = 0;

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] === b[index]) {
      agreements += 1;
    }

    if (a[index] === "CONFIRMED") {
      aConfirmed += 1;
    }

    if (b[index] === "CONFIRMED") {
      bConfirmed += 1;
    }
  }

  const n = a.length;
  const rawAgreement = agreements / n;
  const aConfirmedFraction = aConfirmed / n;
  const bConfirmedFraction = bConfirmed / n;
  const expectedAgreement =
    aConfirmedFraction * bConfirmedFraction + (1 - aConfirmedFraction) * (1 - bConfirmedFraction);
  const denominator = 1 - expectedAgreement;
  const kappa =
    denominator === 0
      ? rawAgreement === 1
        ? 1
        : 0
      : (rawAgreement - expectedAgreement) / denominator;

  return { n, rawAgreement, kappa };
}

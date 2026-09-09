import type { Db } from "../db/open.js";
import { runMeasurementPass } from "../detector/measurement.js";
import { ESF_EFFECT_WRITER_ENABLED } from "../effects/gate.js";
import { effectEngineForDb } from "../query/api/effect-service.js";

const INTERVAL_MS = 60 * 60 * 1000;
const lastPass = new WeakMap<Db, number>();

/** Probe-clock scheduling; restarting can safely replay the bounded, idempotent engine pass. */
export function runEffectMeasurementPass(db: Db, now: Date): void {
  if (!ESF_EFFECT_WRITER_ENABLED) {
    runMeasurementPass(db, now);
    return;
  }
  const previous = lastPass.get(db);
  const current = now.getTime();
  if (previous !== undefined && current >= previous && current - previous < INTERVAL_MS) return;
  lastPass.set(db, current);
  try {
    effectEngineForDb(db).runPass(now);
  } catch {
    // Never expose source identities or DB contents in a background error.
    console.warn("Effect measurement pass failed; retrying on the next scheduled pass.");
  }
}

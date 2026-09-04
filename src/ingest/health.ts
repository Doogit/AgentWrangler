/**
 * src/ingest/health.ts — parser-health counters (NFR-106, first-class metric).
 *
 * Drift in any of these is the early-warning that a Claude Code update changed
 * the transcript schema. Counters are in-memory on the running ingestor and
 * surfaced in Settings (WP4). No content; counts only.
 */

import { type HealthCounters, newHealthCounters } from "./types.js";

export class Health {
  private readonly c: HealthCounters = newHealthCounters();

  fileSeen(): void {
    this.c.filesSeen++;
  }
  fileParsed(): void {
    this.c.filesParsed++;
  }
  quarantined(): void {
    this.c.linesQuarantined++;
  }
  synthetic(): void {
    this.c.syntheticExcluded++;
  }
  duplicateDrop(): void {
    this.c.duplicateDrops++;
  }
  turnIngested(parserVersion: string): void {
    this.c.turnsIngested++;
    this.c.parserVersionMix[parserVersion] = (this.c.parserVersionMix[parserVersion] ?? 0) + 1;
  }
  unknownFields(fields: string[]): void {
    for (const f of fields) {
      this.c.unknownFieldKinds[f] = (this.c.unknownFieldKinds[f] ?? 0) + 1;
    }
  }

  /** Return an immutable snapshot of the current counters. */
  snapshot(): HealthCounters {
    return {
      ...this.c,
      unknownFieldKinds: { ...this.c.unknownFieldKinds },
      parserVersionMix: { ...this.c.parserVersionMix },
    };
  }
}

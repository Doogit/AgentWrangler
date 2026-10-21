import type { PipelineTrace } from "../pipeline.js";
import { oracleA1 } from "./A1.js";
import { oracleA2 } from "./A2.js";
import { oracleB1 } from "./B1.js";
import { oracleB2 } from "./B2.js";
import { oracleB3 } from "./B3.js";
import { oracleB4 } from "./B4.js";
import { oracleC1 } from "./C1.js";
import { oracleC2 } from "./C2.js";
import { oracleC3 } from "./C3.js";
import { oracleC4 } from "./C4.js";
import { oracleC5 } from "./C5.js";
import { oracleC6 } from "./C6.js";
import { oracleC7 } from "./C7.js";
import { oracleC9 } from "./C9.js";
import { oracleC11 } from "./C11.js";
import { oracleD1 } from "./D1.js";
import { oracleD2 } from "./D2.js";
import { oracleD4 } from "./D4.js";
import { oracleD5 } from "./D5.js";
import { oracleD6 } from "./D6.js";
import { oracleD7Loop, oracleD7Xread } from "./D7.js";
import { oracleD8 } from "./D8.js";
import { oracleD9 } from "./D9.js";
import { oracleD10 } from "./D10.js";
import { oracleD11 } from "./D11.js";
import { oracleD12 } from "./D12.js";
import { oracleD14 } from "./D14.js";
import { oracleE1 } from "./E1.js";
import { oracleE2 } from "./E2.js";
import { oracleG11 } from "./G11.js";
import { oracleH1 } from "./H1.js";
import type { Oracle, OracleFigure } from "./types.js";

export interface OracleReg {
  oracle: Oracle;
  figure: OracleFigure;
  /** Detector whose trace is graded when the registry id is a lane (e.g. "D7X" → "D7"). */
  trace_id?: string;
  /** Lane filter: which of the trace's money rows belong to this oracle. */
  rows?: (m: PipelineTrace["money"][number]) => boolean;
}

const isXread = (m: PipelineTrace["money"][number]): boolean =>
  m.scope_key?.startsWith("D7-XREAD|") === true;

/** Detector id → oracle + the card figure it is graded against. Authors add entries. */
export const ORACLES: Record<string, OracleReg> = {
  E1: { oracle: oracleE1, figure: "modeled" },
  D6: { oracle: oracleD6, figure: "headline" },
  A1: { oracle: oracleA1, figure: "headline" },
  D1: { oracle: oracleD1, figure: "headline" },
  D8: { oracle: oracleD8, figure: "headline" },
  B1: { oracle: oracleB1, figure: "headline" },
  D4: { oracle: oracleD4, figure: "headline" },
  C6: { oracle: oracleC6, figure: "reliability" },
  C9: { oracle: oracleC9, figure: "count" },
  H1: { oracle: oracleH1, figure: "count" },
  E2: { oracle: oracleE2, figure: "count" },
  D5: { oracle: oracleD5, figure: "count" },
  B4: { oracle: oracleB4, figure: "count" },
  C2: { oracle: oracleC2, figure: "reliability" },
  D9: { oracle: oracleD9, figure: "count" },
  G11: { oracle: oracleG11, figure: "count" },
  C11: { oracle: oracleC11, figure: "reliability" },
  C3: { oracle: oracleC3, figure: "reliability" },
  D14: { oracle: oracleD14, figure: "reliability" },
  C5: { oracle: oracleC5, figure: "count" },
  C4: { oracle: oracleC4, figure: "reliability" },
  D11: { oracle: oracleD11, figure: "reliability" },
  C7: { oracle: oracleC7, figure: "reliability" },
  B3: { oracle: oracleB3, figure: "headline" },
  D2: { oracle: oracleD2, figure: "headline" },
  C1: { oracle: oracleC1, figure: "reliability" },
  D10: { oracle: oracleD10, figure: "headline" },
  D12: { oracle: oracleD12, figure: "modeled" },
  A2: { oracle: oracleA2, figure: "headline" },
  D7: { oracle: oracleD7Loop, figure: "modeled", rows: (m) => !isXread(m) },
  D7X: { oracle: oracleD7Xread, figure: "headline", trace_id: "D7", rows: isXread },
  B2: { oracle: oracleB2, figure: "count" },
};

/** The trace to grade for a registry entry: its lane's money rows only. */
export function laneTrace(reg: OracleReg, trace: PipelineTrace): PipelineTrace {
  return reg.rows ? { ...trace, money: trace.money.filter(reg.rows) } : trace;
}

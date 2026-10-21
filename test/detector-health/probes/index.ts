/** DH2 probe registry: detector id -> probe. */

import { probeA1 } from "./A1.js";
import { probeA2 } from "./A2.js";
import { probeB1 } from "./B1.js";
import { probeB2 } from "./B2.js";
import { probeB3 } from "./B3.js";
import { probeB4 } from "./B4.js";
import { probeC1 } from "./C1.js";
import { probeC2 } from "./C2.js";
import { probeC3 } from "./C3.js";
import { probeC4 } from "./C4.js";
import { probeC5 } from "./C5.js";
import { probeC6 } from "./C6.js";
import { probeC7 } from "./C7.js";
import { probeC9 } from "./C9.js";
import { probeC11 } from "./C11.js";
import { probeD1 } from "./D1.js";
import { probeD2 } from "./D2.js";
import { probeD4 } from "./D4.js";
import { probeD5 } from "./D5.js";
import { probeD6 } from "./D6.js";
import { probeD7 } from "./D7.js";
import { probeD8 } from "./D8.js";
import { probeD9 } from "./D9.js";
import { probeD10 } from "./D10.js";
import { probeD11 } from "./D11.js";
import { probeD12 } from "./D12.js";
import { probeD14 } from "./D14.js";
import { probeE1 } from "./E1.js";
import { probeE2 } from "./E2.js";
import { probeG11 } from "./G11.js";
import { probeH1 } from "./H1.js";
import type { Probe } from "./types.js";

export const PROBES: Record<string, Probe> = {
  A1: probeA1,
  A2: probeA2,
  B1: probeB1,
  B2: probeB2,
  B3: probeB3,
  B4: probeB4,
  C1: probeC1,
  C2: probeC2,
  C3: probeC3,
  C4: probeC4,
  C5: probeC5,
  C6: probeC6,
  C7: probeC7,
  C9: probeC9,
  C11: probeC11,
  D1: probeD1,
  D2: probeD2,
  D4: probeD4,
  D5: probeD5,
  D6: probeD6,
  D7: probeD7,
  D8: probeD8,
  D9: probeD9,
  D10: probeD10,
  D11: probeD11,
  D12: probeD12,
  D14: probeD14,
  E1: probeE1,
  E2: probeE2,
  G11: probeG11,
  H1: probeH1,
};

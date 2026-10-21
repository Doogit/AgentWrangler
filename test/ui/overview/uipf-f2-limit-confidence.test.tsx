/** UIP-F2: weekly burn forecast limit-confidence display.
 *
 * All tests in this file were DELETED.
 * BurnForecastCard — including the .overview-kpi-tile-hero tile, the "Weekly burn forecast"
 * heading, burn-low-confidence/burn-cold-start testids, and the forecast.state / limit_tokens
 * shape — was removed from OverviewPage in overview-v2. The UsageLimitsCard (§1) replaces it,
 * polling /api/query/limits for live session and spend data.
 */

import { describe, it } from "vitest";

describe("OverviewPage burn hero calibrated-limit confidence", () => {
  it.todo(
    "BurnForecastCard removed in overview-v2; limit display migrated to UsageLimitsCard (§1)",
  );
});

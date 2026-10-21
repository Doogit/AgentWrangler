import type { Db } from "../db/open.js";
import { getPractices } from "../detector/practice-registry.js";
import { getDeliveryMetrics } from "../query/api/delivery.js";

/** P1-U8: what one route snapshot computes. The window is resolved when its build starts. */
export type RouteSnapshotSpec =
  | { route: "delivery"; workspaceId: string | null; from: string; to: string }
  | { route: "practices"; from: string; to: string; persistedStrip: boolean };

/** The old synchronous handler bodies; run in the route-snapshot worker (or in-process). */
export function buildRouteSnapshot(db: Db, spec: RouteSnapshotSpec): unknown {
  if (spec.route === "delivery") {
    return getDeliveryMetrics(db, { workspaceId: spec.workspaceId, from: spec.from, to: spec.to });
  }
  return getPractices(db, { from: spec.from, to: spec.to, persistedStrip: spec.persistedStrip });
}

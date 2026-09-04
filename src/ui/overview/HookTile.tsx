/**
 * src/ui/overview/HookTile.tsx — Context-budget hook install state tile.
 *
 * If hook is installed: confirms the context-budget + loop-guard hooks are active.
 * If NOT installed: the tile IS the install CTA (link to Settings).
 * Source: GET /api/hook-config (already in client.ts).
 */

import type { HookConfigResponse } from "../../query/api/hook-config";
import InfoTip from "../shell/InfoTip";

interface Props {
  hookConfig: HookConfigResponse | null;
  isLoading: boolean;
}

export default function HookTile({ hookConfig, isLoading }: Props) {
  return (
    <div className="card" data-testid="hook-tile" style={{ padding: "14px 16px" }}>
      <div style={{ marginBottom: 10, fontWeight: 700, fontSize: 13, color: "var(--soft)" }}>
        CONTEXT-BUDGET HOOK{" "}
        <InfoTip
          label="What the context-budget hook does"
          content="A one-line install that warns you in-session as context fills, so you checkpoint before a costly auto-compact. Install it from Settings if the tile shows it's off."
        />
      </div>

      {isLoading && (
        <div
          className="skeleton"
          style={{ height: 48, borderRadius: 6 }}
          aria-label="Loading hook status"
        />
      )}

      {!isLoading && hookConfig === null && (
        <div className="kpi-off-hint" style={{ fontSize: 12 }}>
          Hook status unavailable.
        </div>
      )}

      {!isLoading && hookConfig !== null && hookConfig.installed && (
        <div>
          <div
            data-testid="hook-installed-badge"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 10px",
              borderRadius: 20,
              background: "rgba(63,166,107,.15)",
              color: "var(--green, #3fa66b)",
              fontSize: 12,
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            <span aria-hidden="true">✓</span> Installed
          </div>
          <div style={{ fontSize: 12, color: "var(--soft)", lineHeight: 1.5 }}>
            Context-budget hook active. Loop-guard also monitors excessive tool-call cycles.
          </div>
        </div>
      )}

      {!isLoading && hookConfig !== null && !hookConfig.installed && (
        <div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--soft)",
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            Install the context-budget hook to automatically pause sessions before they hit the rate
            limit.
          </div>
          <a
            href="#/settings"
            style={{
              display: "inline-block",
              padding: "4px 12px",
              borderRadius: 6,
              background: "var(--teal)",
              color: "#fff",
              fontSize: 12,
              fontWeight: 700,
              textDecoration: "none",
            }}
            data-testid="hook-install-cta"
          >
            Install in Settings →
          </a>
        </div>
      )}
    </div>
  );
}

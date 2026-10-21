/**
 * OV-12 U5 (D6) — Settings "Model weight check" card: the not-ready state (the live 2026-10-04 data:
 * 3 readings across 2 weeks) and a fitted example. Diagnostic only.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockSettings, mockWeightFit } from "../../src/ui/api/fixtures";
import { METRIC_COPY } from "../../src/ui/lib/metric-copy";
import SettingsPage from "../../src/ui/settings/SettingsPage";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
  vi.mocked(client.saveSettings).mockResolvedValue(mockSettings());
  vi.mocked(client.resetDatabase).mockResolvedValue(mockSettings());
});

const rowText = (card: HTMLElement, family: string) =>
  [...card.querySelectorAll("tbody tr")].find((r) => r.textContent?.startsWith(family))
    ?.textContent;

describe("Model weight check", () => {
  it("not enough data: counts vs the gate, list weights, no fitted values", async () => {
    vi.mocked(client.fetchWeightFit).mockResolvedValue(mockWeightFit("not-ready"));
    render(<SettingsPage />);
    const card = await screen.findByTestId("weight-check");
    await waitFor(() => expect(card.textContent).toContain("Not enough data yet"));
    expect(card.textContent).toContain("Readings 3 / 6");
    expect(card.textContent).toContain("Weeks 2 / 3");
    expect(card.textContent).toContain("Varied mix ✓");
    expect(rowText(card, "Opus")).toBe("Opus2–2.5×——");
    expect(rowText(card, "Sonnet")).toBe("Sonnet1–1.5×1–1.5×Reference");
    expect(rowText(card, "Haiku")).toBe("Haiku0.5×—Too little use to fit");
    expect(card.textContent).not.toContain("Weekly max spread");
  });

  it("fitted: fitted range, verdict chips, spread before → after", async () => {
    vi.mocked(client.fetchWeightFit).mockResolvedValue(mockWeightFit("ready"));
    render(<SettingsPage />);
    const card = await screen.findByTestId("weight-check");
    await waitFor(() =>
      expect(card.textContent).toContain("Fitted from 7 readings across 4 weeks"),
    );
    expect(rowText(card, "Opus")).toBe("Opus2–2.5×1.9–2.4×Matches price");
    expect(rowText(card, "Fable")).toBe("Fable5×3.6×Counts less than price");
    expect(within(card).getByText("Counts less than price").className).toBe("chip unv");
    expect(card.textContent).toContain(
      "Weekly max spread: ±4.4% at list prices → ±1.9% with fitted weights.",
    );
  });

  it("tooltip is short", () => {
    const { what, read, act } = METRIC_COPY["limits.weight_fit"];
    expect(`${what} ${read} ${act}`.length).toBeLessThanOrEqual(160);
  });
});

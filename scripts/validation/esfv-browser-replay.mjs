// ESFV browser acceptance replay — eight merged ESFV surfaces on the synthetic
// esfv-browser-server (ESF5 corpus + ESFV seed extensions). Desktop 1440 + 390,
// keyboard, dark/light screenshots. No operator daemon, no live DB.
// Run: npx --package @playwright/cli playwright-cli -s=esfv open <ESFV_SYNTHETIC_URL>
// then: npx --package @playwright/cli playwright-cli -s=esfv run-code --filename scripts/validation/esfv-browser-replay.mjs
async (page) => {
  page.setDefaultTimeout(9000);
  const base = page.url().split("/").slice(0, 3).join("/");
  const out = "output/playwright/esfv";
  const rows = [];
  const check = (yes, message) => {
    if (!yes) throw new Error(message);
  };
  const run = async (id, width, action, decision, fn) => {
    try {
      await fn();
      rows.push({ id, width, action, decision, status: "PASS" });
    } catch (e) {
      rows.push({ id, width, action, decision, status: "FAIL", failure: String(e).slice(0, 500) });
    }
  };
  const settle = async () => {
    await page.waitForTimeout(250);
  };
  const noOverflow = async (label) => {
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `Horizontal overflow on ${label}`,
    );
  };
  for (const width of [1440, 390]) {
    const first = width === 1440;
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date("2026-08-15T00:00:00Z"));

    // ---- ESFV-3 + ESFV-4: Overview observation strip, drill-ins, window labels
    await run(
      "ESFV-3:drill-in",
      width,
      "Open evidence and limits; drill into cohort session tables",
      "Cohorts are counts + linked tables, never UUID walls",
      async () => {
        await page.goto(base + "/#/");
        await page.locator('[data-testid="overview-data-notes"] > summary').click();
        await page
          .getByRole("combobox", { name: "Observation workspace" })
          .selectOption("ws-alpha");
        const panel = page.locator("[data-testid=esf-observation-evidence]");
        await panel.getByText("repeated test-failure sessions", { exact: false }).waitFor();
        const launcher = panel.getByRole("button", { name: "View evidence and limits" });
        await launcher.focus();
        await page.keyboard.press("Enter");
        check(
          await page
            .getByRole("heading", { name: "Evidence and limits", exact: true })
            .evaluate((e) => e === document.activeElement),
          "Disclosure focus moves to the heading",
        );
        let t = await panel.innerText();
        check(/6\s*\/\s*18 repeated test-failure sessions/.test(t), "n/N adjacency missing");
        check(t.includes("affected") && t.includes("later recovered"), "Affected-recovered relationship sentence missing");
        check(!/ses-a01,\s*ses-a02,\s*ses-a03/.test(t), "Comma-separated UUID wall still renders");
        const drill = panel.getByRole("button", { name: /^View sessions \(\d+\)/ }).first();
        await drill.click();
        await panel.getByRole("columnheader", { name: "Session", exact: true }).first().waitFor();
        for (const header of ["State", "Cost", "Last active"])
          check(
            (await panel.getByRole("columnheader", { name: header, exact: true }).count()) > 0,
            `Drill-in table header ${header} missing`,
          );
        t = await panel.innerText();
        check(t.includes("ses-a0"), "Cohort sessions absent from drill-in table");
        check(t.includes("esf-observed-test-recovery-1"), "Method text not preserved");
        await panel.screenshot({ path: `${out}/esfv3-drill-in-${width}.png` });
        await page.keyboard.press("Escape");
        check(
          await launcher.evaluate((e) => e === document.activeElement),
          "Escape restores focus to the launcher",
        );
        await noOverflow("overview");
      },
    );
    await run(
      "ESFV-4:window-and-prior",
      width,
      "Read humanized window; expand the exact contract; read prior-window handling",
      "Descriptive prior figures or an explicit not-comparable reason; never a promoted delta",
      async () => {
        const panel = page.locator("[data-testid=esf-observation-evidence]");
        const contract = panel.locator("details", { hasText: "Window contract" }).first();
        await contract.locator("summary").click();
        const t = await panel.innerText();
        check(
          t.includes("[2026-08-01T00:00:00.000Z, 2026-08-15T00:00:00.000Z)"),
          "Exact half-open window contract missing on expand",
        );
        // Harness limitation: the synthetic server pins every observation read to the
        // corpus bounds, so the prior-window probe returns the same window and the
        // honest not-comparable path is what must render.
        check(
          t.includes("Prior window not comparable:") ||
            t.includes("Prior-window figures are descriptive, not a delta."),
          "Neither descriptive prior figures nor a mismatch reason rendered",
        );
        await panel.screenshot({ path: `${out}/esfv4-strip-${width}.png` });
      },
    );
    await run(
      "ESFV-4:outcome-signal",
      width,
      "Read the Workspaces outcome-signal definition and keyboard row navigation",
      "Early estimate is defined on-page; rows navigate by keyboard",
      async () => {
        await page.goto(base + "/#/workspaces");
        await page.getByRole("heading", { name: "Workspaces", exact: true }).waitFor();
        await settle();
        // The synthetic corpus has no repo-mapped workspaces; the honest default is
        // the transient-hidden empty state. Reveal transient rows to exercise the column.
        await page.getByText("No workspaces yet", { exact: true }).waitFor();
        await page.getByRole("checkbox", { name: "Show transient workspaces" }).check();
        const th = page.locator('th[aria-label="Outcome signal"]');
        await th.waitFor();
        check(
          (await th.getAttribute("title")) ===
            "Outcome signal: based on a limited sample and may change.",
          "Outcome signal column caveat title missing",
        );
        check(
          (await page.getByRole("button", { name: "What outcome signal means" }).count()) > 0 ||
            (await page.locator('[aria-label="What outcome signal means"]').count()) > 0,
          "Outcome signal definition InfoTip missing",
        );
        const row = page.getByRole("row", { name: /Open .* workspace detail/ }).first();
        await row.focus();
        await page.keyboard.press("Enter");
        await page.waitForURL(/#\/workspaces\/.+/);
        await noOverflow("workspaces list");
      },
    );

    // ---- ESFV-5: workspace Outcomes stat cards + delivery card (ws-alpha)
    await run(
      "ESFV-5:delivery-and-outcomes",
      width,
      "Read the delivery card and outcome stat cards on workspace detail",
      "ESF1 wording with n/N and coverage; no single-row nine-column table",
      async () => {
        await page.goto(base + "/#/workspaces/ws-alpha");
        const delivery = page.locator("[data-testid=workspace-delivery-card]");
        await delivery.getByText("Commit-session rate", { exact: true }).waitFor();
        const t = await delivery.innerText();
        check(t.includes("Observed delivery proxy"), "Delivery card heading missing");
        check(/\d+\/\d+ sessions with an\s+observed commit/.test(t), "Commit-session n/N missing");
        check(
          t.includes("Bash/edit activity without an observed commit"),
          "ESF1 no-commit wording missing",
        );
        // "abandonment" may only appear as the explicit ESF1 disclaimer, never a claim.
        const full = (await delivery.evaluate((e) => e.textContent)) ?? "";
        for (const match of full.matchAll(/.{30}abandonment/gis))
          check(
            /not an?\s+abandonment$/i.test(match[0]),
            `Affirmative abandonment wording: …${match[0].slice(-45)}`,
          );
        check(
          t.includes("LIVE sessions remain in total spend"),
          "Delivery qualification note missing",
        );
        await page.locator("[data-testid=closure-follow-up-bar]").waitFor();
        await page.locator("[data-testid=r4a-cost-per-success]").waitFor();
        const cps = await page.locator("[data-testid=r4a-cost-per-success]").innerText();
        check(
          cps.includes("No merged pull requests are linked in this period") ||
            cps.includes("unlinked spend excluded — survivorship"),
          "Merged-PR coverage/survivorship handling missing",
        );
        await delivery.screenshot({ path: `${out}/esfv5-delivery-${width}.png` });
        await page
          .locator("[data-testid=ef2-closure-proxy]")
          .screenshot({ path: `${out}/esfv5-closure-${width}.png` });
        await noOverflow("workspace detail ws-alpha");
      },
    );
    // ---- ESFV-2: adoption loop (empty CTA on ws-alpha; outcome bar on ws-shared)
    await run(
      "ESFV-2:empty-cta",
      width,
      "Read the zero-record empty state on ws-alpha",
      "CTA path with a benefit sentence, no dead end",
      async () => {
        const work = page.getByLabel("Useful work reported").first();
        await work.getByText("No current work records in this scope.").waitFor();
        const t = await work.innerText();
        check(
          t.includes("Report outcomes to see cost per useful task."),
          "Benefit sentence missing from empty state",
        );
        check(
          (await work.getByRole("button", { name: "Create a work record" }).count()) > 0,
          "Create CTA missing from empty state",
        );
        await work.screenshot({ path: `${out}/esfv2-empty-cta-${width}.png` });
      },
    );
    await run(
      "ESFV-2:outcome-bar",
      width,
      "Read the stacked outcome bar and coverage on ws-shared",
      "Terminal denominator holds the four reported terminal categories only",
      async () => {
        await page.goto(base + "/#/workspaces/ws-shared");
        const work = page.getByLabel("Useful work reported").first();
        await work.getByText("Feedback coverage:", { exact: false }).waitFor();
        const t = await work.innerText();
        check(
          t.includes("1 useful / 2 reported terminal records"),
          "Useful-per-terminal coverage missing",
        );
        check(
          t.includes("Feedback coverage: 2 / 4 current records."),
          "Reported/all coverage missing",
        );
        check(
          t.includes(
            "ACTIVE, UNKNOWN, and UNREPORTED are outside this denominator",
          ),
          "Terminal denominator sentence missing",
        );
        const bar = page.locator('[aria-label="Reported work outcomes"]');
        check((await bar.count()) > 0, "Outcome bar missing");
        check(
          (await page.locator('[aria-label="Outcomes outside the terminal denominator"]').count()) >
            0,
          "Outside-denominator segments not separated",
        );
        await work.screenshot({ path: `${out}/esfv2-outcome-bar-${width}.png` });
        await noOverflow("workspace detail ws-shared");
      },
    );
    // ---- ESFV-7: saved cost reports (ws-shared)
    await run(
      "ESFV-7:saved-reports",
      width,
      first
        ? "Save a new report, then read it back from the list without knowing its ID"
        : "Read the previously saved report back from the list",
      "Frozen reports are listed and readable; conservation figures render",
      async () => {
        const panel = page.getByLabel("Saved cost reports").first();
        await panel.getByRole("heading", { name: "Saved cost reports" }).waitFor();
        const t = await panel.innerText();
        check(
          t.includes("a saved report freezes membership + pricing at a moment"),
          "Explainer sentence missing",
        );
        check(!t.includes("Frozen report ID"), "Raw report-ID input still renders");
        if (first) {
          check(t.includes("No saved cost reports."), "Empty list state missing before first save");
          await panel.getByRole("button", { name: "Save a new report" }).click();
        }
        const idButton = panel
          .locator("tbody tr")
          .first()
          .getByRole("button");
        await idButton.waitFor();
        const rowText = await panel.locator("tbody tr").first().innerText();
        check(/\[\d{4}-\d{2}-\d{2}T.*\)/.test(rowText), "Report window cell missing");
        check(/\d+ \/ \d+/.test(rowText), "Report coverage cell missing");
        await idButton.click();
        await panel.getByText("Conservation (priced micro-USD):", { exact: false }).waitFor();
        const report = await panel.innerText();
        check(
          /Conservation \(priced micro-USD\): [\d,]+ allocated \+ [\d,]+ unallocated = [\d,]+ total\./.test(
            report,
          ),
          "Conservation identity missing",
        );
        await panel.screenshot({ path: `${out}/esfv7-saved-reports-${width}.png` });
      },
    );

    // ---- ESFV-8: session timeline observation markers (ses-a01)
    await run(
      "ESFV-8:timeline-markers",
      width,
      "Inspect observation markers, legend and the evidence link on ses-a01",
      "Markers are observations, not task-quality labels",
      async () => {
        await page.goto(base + "/#/sessions/ses-a01");
        const chart = page.locator("[data-testid=context-growth-chart]");
        await chart.waitFor();
        await settle();
        const fails = chart.locator(
          '[data-testid=timeline-observation-marker][data-observation-kind="failure"]',
        );
        const passes = chart.locator(
          '[data-testid=timeline-observation-marker][data-observation-kind="pass"]',
        );
        check((await fails.count()) > 0, "No failure glyphs on the timeline");
        check((await passes.count()) > 0, "No pass glyph on the timeline");
        check(
          /Observed completed-test failure at turn \d+/.test(
            (await fails.first().getAttribute("aria-label")) ?? "",
          ),
          "Failure marker aria-label missing",
        );
        const legend = page.locator("[data-testid=timeline-observation-legend]");
        await legend.waitFor();
        const legendText = await legend.innerText();
        check(
          legendText.includes("observations, not task outcomes"),
          "Legend caveat missing",
        );
        const evidence = page.locator("[data-testid=esf-session-observed-evidence]");
        const link = evidence.getByText("repeated test failures, then an observed later pass", {
          exact: false,
        });
        check((await link.count()) > 0, "Observed-evidence sentence missing its chart link");
        await chart.screenshot({ path: `${out}/esfv8-markers-${width}.png` });
        await noOverflow("session detail ses-a01");
      },
    );

    // ---- ESFV-1 + ESFV-6: recommendations evaluation lanes + cycle history
    await page.goto(base + "/#/recommendations");
    await page.locator("[data-testid=effect-evidence]").first().waitFor();
    await settle();
    // The same rec's evidence renders in several page regions; anchor each check
    // on an effect-evidence block that carries the feature under test.
    const evidenceFor = (cycleId, extra = {}) =>
      page
        .locator("[data-testid=effect-evidence]")
        .filter({ hasText: `Frozen cycle ID: ${cycleId}.` })
        .filter(extra)
        .first();
    await run(
      "ESFV-1:verdict-lanes",
      width,
      "Read the three verdict lanes on the finalized adverse-guardrail cycle",
      "A favorable target never styles as success while a guardrail is adverse",
      async () => {
        const block = evidenceFor("cycle-d4-01", {
          has: page.locator('[aria-label="Target verdict"]'),
        });
        await block.locator('[aria-label="Target verdict"]').waitFor();
        for (const lane of ["Target verdict", "Guardrail verdict", "Comparability verdict"])
          check((await block.locator(`[aria-label="${lane}"]`).count()) > 0, `${lane} lane missing`);
        const target = await block.locator('[aria-label="Target verdict"]').innerText();
        check(target.includes("IMPROVED"), "Target direction missing from the lane");
        check(target.includes("material-change band"), "Material-change band missing");
        check(
          target.includes(
            "Target is not styled as a success: a guardrail is adverse or unsupported.",
          ),
          "Adverse-guardrail block sentence missing",
        );
        const guardrails = await block.locator('[aria-label="Guardrail verdict"]').innerText();
        check(/→/.test(guardrails), "Guardrail before → after values missing");
        check(guardrails.includes("ADVERSE"), "Adverse direction chip missing");
        const evidence = await block.innerText();
        check(
          evidence.includes("Final evidence") || evidence.includes("Provisional evidence"),
          "Provisional/final evidence label missing",
        );
        await block.screenshot({ path: `${out}/esfv1-lanes-${width}.png` });
      },
    );
    const historyBlock = page
      .locator("[data-testid=effect-evidence]")
      .filter({ has: page.locator('[aria-label="Measurement cycle timeline"]') })
      .first();
    await run(
      "ESFV-1:progress-header",
      width,
      "Read the open-cycle progress header and pending maturity chip",
      "Maturity is progress, not absence",
      async () => {
        await historyBlock.waitFor();
        // Select the open cycle (#2) in the timeline, then read its progress header.
        await historyBlock
          .locator('[aria-label="Measurement cycle timeline"]')
          .getByRole("button", { name: /^#2 / })
          .first()
          .click();
        await historyBlock
          .getByText("Frozen cycle ID: cycle-d2-retrack.", { exact: false })
          .waitFor();
        const t = await historyBlock.innerText();
        check(
          /Measuring · day \d+ of \d+ · after-window sessions \d+\/\d+/.test(t),
          "Open-cycle progress header missing",
        );
        check(/PENDING — \d+ of \d+ gate/.test(t), "PENDING maturity StateChip missing");
        check(
          (await historyBlock.locator('[aria-label="Target verdict"]').count()) === 0,
          "Verdict lanes rendered for an open cycle",
        );
        await historyBlock.screenshot({ path: `${out}/esfv1-progress-${width}.png` });
      },
    );
    await run(
      "ESFV-6:cycle-timeline",
      width,
      "Select the frozen prior cycle from the measurement-cycle timeline by keyboard",
      "Prior cycles are immutable and labeled with their contract version",
      async () => {
        const timeline = historyBlock.locator('[aria-label="Measurement cycle timeline"]');
        await timeline.waitFor();
        check(
          /measurement cycles/i.test(await timeline.innerText()),
          "Timeline heading missing",
        );
        const chips = timeline.getByRole("button", { name: /^#\d+ / });
        check((await chips.count()) === 2, "Expected two cycle chips");
        const current = chips.filter({ hasText: "#2" }).first();
        check(
          (await current.getAttribute("aria-pressed")) === "true",
          "Latest cycle chip not marked selected",
        );
        const prior = chips.filter({ hasText: "#1" }).first();
        check(
          ((await prior.getAttribute("aria-label")) ?? "").includes(
            "Contract version esf-effect-1",
          ),
          "Contract-version label missing from the prior chip",
        );
        await prior.focus();
        await page.keyboard.press("Enter");
        await historyBlock.getByText("Frozen cycle ID: cycle-d2-02.", { exact: false }).waitFor();
        const t = await historyBlock.innerText();
        check(t.includes("STOPPED"), "Frozen prior cycle state missing after selection");
        check(t.includes("ROLLBACK_IN_WINDOW"), "Frozen rollback evidence missing");
        check((await prior.getAttribute("aria-pressed")) === "true", "Selection state not updated");
        await historyBlock.screenshot({ path: `${out}/esfv6-timeline-${width}.png` });
        // Restore the latest cycle so the page state is unchanged for later checks.
        await chips.filter({ hasText: "#2" }).first().click();
      },
    );
    await run(
      "ESFV-1:pre-track-summary",
      width,
      "Open the pre-track Evaluation on an untracked recommendation",
      "One summary line first; detail is an explicit expansion",
      async () => {
        const card = page
          .locator(".rec-card")
          .filter({ hasText: "Stop repeated attempts" })
          .first();
        await card.waitFor();
        const menu = card.locator(".rec-actions-menu");
        if ((await menu.getAttribute("open")) === null) await menu.locator("summary").click();
        await card.getByRole("button", { name: "Evaluation", exact: true }).click();
        const region = card.getByRole("region", { name: "Evaluation", exact: true });
        await region.waitFor();
        const t = await region.innerText();
        check(
          t.includes("Not measured yet — confirm a completed change to start measurement"),
          "Pre-track one-line summary missing",
        );
        check(t.includes("Evaluation details"), "Expandable detail summary missing");
        const details = region.locator("details", { hasText: "Evaluation details" }).first();
        check(
          (await details.getAttribute("open")) === null,
          "Detail expands by default instead of collapsing to the summary line",
        );
        await details.locator("summary").click();
        check(
          (await region.innerText()).includes("available after tracking starts"),
          "Expanded detail lost the tracking qualification",
        );
        await region.screenshot({ path: `${out}/esfv1-pretrack-${width}.png` });
        await page.keyboard.press("Escape");
        await noOverflow("recommendations");
      },
    );

  }

  // ---- Alternate-theme screenshots (assertions above ran in the default theme,
  // which is dark; this pass toggles at 1440 — the toggle sits in the desktop
  // sidebar — then captures both widths in the other theme)
  await run(
    "ESFV:alt-theme",
    "1440+390",
    "Toggle the theme and capture the key surfaces in the other theme at both widths",
    "Both themes render the ESFV surfaces",
    async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(base + "/#/");
      const toggle = page.getByRole("button", { name: /Switch to (dark|light) theme/ }).first();
      await toggle.waitFor();
      const target = /dark/.test((await toggle.getAttribute("aria-label")) ?? "")
        ? "dark"
        : "light";
      await toggle.click();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const [route, shot, ready] of [
          ["/#/recommendations", "recommendations", "[data-testid=effect-evidence]"],
          ["/#/workspaces/ws-alpha", "workspace", "[data-testid=workspace-delivery-card]"],
          ["/#/sessions/ses-a01", "session", "[data-testid=context-growth-chart]"],
          ["/#/", "overview", "[data-testid=overview-data-notes]"],
        ]) {
          await page.goto(base + route);
          await page.locator(ready).first().waitFor();
          await settle();
          await page.screenshot({
            path: `${out}/${target}-${shot}-${width}.png`,
            fullPage: false,
          });
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page
        .getByRole("button", { name: /Switch to (dark|light) theme/ })
        .first()
        .click();
    },
  );

  // ---- ESFV-2: one-click create + attach from session detail (once; ws-live so
  // the ws-shared counts asserted at both widths stay untouched)
  await page.setViewportSize({ width: 1440, height: 900 });
  await run(
    "ESFV-2:create-attach",
    1440,
    "Create a work record from session detail with one click",
    "The created record lands with this session attached",
    async () => {
      await page.goto(base + "/#/sessions/ses-l04");
      const attach = page.getByRole("button", { name: "Create and attach this session" }).first();
      await attach.waitFor();
      await attach.click();
      await settle();
      const work = page.getByLabel("Useful work reported").first();
      await page.getByText("ses-l04", { exact: false }).first().waitFor();
      const body = await page.locator("body").innerText();
      check(!body.includes("No session membership."), "Created record lacks session membership");
      await work.screenshot({ path: `${out}/esfv2-create-attach-1440.png` });
    },
  );

  return {
    reviewer: "automated synthetic browser reviewer; not human testing",
    server: base,
    window: "[2026-08-01,2026-08-15)",
    presetSelection: "not evaluated; harness supplies explicit window",
    priorWindowCompare:
      "not exercisable in this harness (observation reads pinned to corpus bounds); the honest not-comparable path is asserted instead",
    rows,
  };
}

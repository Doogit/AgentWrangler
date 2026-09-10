async (page) => {
  page.setDefaultTimeout(7000);
  const base = page.url().split("/").slice(0, 3).join("/");
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
  const text = async () => await page.locator("body").innerText();
  const settle = async () => {
    await page.waitForTimeout(250);
  };
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date("2026-08-15T00:00:00Z"));
    await run(
      "FX-RECOVER-18",
      width,
      "Open exact cohort and linked session evidence",
      "Collect more evidence; recovered tests do not prove task success",
      async () => {
        await page.goto(base + "/#/");
        await page.locator('[data-testid="overview-data-notes"] > summary').click();
        await page
          .getByRole("combobox", { name: "Observation workspace" })
          .selectOption("ws-alpha");
        const panel = page.locator("[data-testid=esf-observation-evidence]");
        await panel.getByText("6 / 18 repeated test-failure sessions", { exact: false }).waitFor();
        let t = await panel.innerText();
        for (const s of [
          "$0.86",
          "19 priced turns",
          "2 unpriced turns",
          "3 recovered test sequences",
          "2026-08-01T00:00:00.000Z",
          "2026-08-15T00:00:00.000Z",
        ])
          check(t.includes(s), "Overview missing " + s);
        const launcher = panel.getByRole("button", { name: "View evidence and limits" });
        await launcher.focus();
        await page.keyboard.press("Enter");
        check(
          await page
            .getByRole("heading", { name: "Evidence and limits", exact: true })
            .evaluate((e) => e === document.activeElement),
          "Disclosure focus",
        );
        t = await panel.innerText();
        for (const id of ["ses-a01", "ses-a02", "ses-a03", "ses-a04", "ses-a05", "ses-a06"])
          check(t.includes(id), "Missing " + id);
        check(t.includes("does not establish task success"), "Missing outcome limit");
        await panel.screenshot({ path: `output/playwright/esf5/recovery-overview-${width}.png` });
        await page.keyboard.press("Escape");
        check(
          await launcher.evaluate((e) => e === document.activeElement),
          "Escape focus restoration",
        );
        await page.goto(base + "/#/workspaces/ws-alpha");
        await page.getByText("6 / 18 repeated test-failure sessions", { exact: false }).waitFor();
        t = await page.locator("[data-testid=esf-observation-evidence]").innerText();
        check(t.includes("$0.86"), "workspace resource differs");
        await page.goto(base + "/#/sessions/ses-a01");
        await page.locator("[data-testid=esf-session-observed-evidence]").waitFor();
        await settle();
        t = await page.locator("[data-testid=esf-session-observed-evidence]").innerText();
        check(!t.includes("6 / 18"), "Session inherited workspace numerator");
        check(t.includes("ses-a01"), "Session ID missing");
      },
    );
    await run(
      "FX-RESEARCH-NC",
      width,
      "Read activity details; no inferred intent",
      "Collect more evidence; no abandonment conclusion",
      async () => {
        await page.goto(base + "/#/workspaces/ws-research");
        const p = page.locator("[data-testid=esf-observation-evidence]");
        await p.getByRole("button", { name: "View evidence and limits" }).click();
        const t = await p.innerText();
        check(t.includes("4 reconciled Bash/edit activity"), "Research denominator");
        check(t.includes("ses-r04"), "Research IDs");
        check(!t.includes("ses-r05,"), "Excluded session in activity");
        await p.screenshot({ path: `output/playwright/esf5/research-${width}.png` });
      },
    );
    await run(
      "FX-SHARED-COST",
      width,
      "Recompute then read the frozen allocation",
      "Keep report; shared cost stays unallocated",
      async () => {
        await page.goto(base + "/#/workspaces/ws-shared");
        await page.getByRole("button", { name: "Recompute allocation" }).click();
        await page.getByRole("textbox", { name: "Frozen report ID" }).waitFor();
        await settle();
        const report = await page.getByRole("textbox", { name: "Frozen report ID" }).inputValue();
        check(report.length > 0, "No frozen report ID");
        let t = await text();
        check(t.includes("$0.11"), "Shared amount missing");
        await page.getByRole("button", { name: "Read frozen report" }).click();
        await settle();
        check(
          (await page.getByRole("textbox", { name: "Frozen report ID" }).inputValue()) === report,
          "Frozen report changed",
        );
        await page
          .locator("[data-testid=esf-observation-evidence]")
          .screenshot({ path: `output/playwright/esf5/shared-${width}.png` });
      },
    );
    await run(
      "FX-LIVE-SPARSE",
      width,
      "Inspect unreported feedback without submitting a report",
      "Collect more evidence; LIVE and unpriced coverage limited",
      async () => {
        await page.goto(base + "/#/workspaces/ws-live");
        const p = page.locator("[data-testid=esf-observation-evidence]");
        await p.getByRole("button", { name: "View evidence and limits" }).waitFor();
        await settle();
        const t = await p.innerText();
        for (const s of [
          "$0.03",
          "3 priced LIVE sessions",
          "1 unpriced turns",
          "UNREPORTED",
          "UNKNOWN",
        ])
          check(t.includes(s), "Missing " + s);
        await p.screenshot({ path: `output/playwright/esf5/live-${width}.png` });
      },
    );
    await page.goto(base + "/#/recommendations");
    await page.locator("[data-testid=effect-evidence]").first().waitFor();
    await settle();
    await run(
      "FX-RECOVER-18:D7",
      width,
      "Open D7 details and available measurement",
      "Collect more evidence; workspace tracking is available",
      async () => {
        const card = page
          .locator(".rec-card")
          .filter({ hasText: "Stop repeated attempts" })
          .first();
        const launcher = card.getByRole("button", { name: /Show details/ });
        await launcher.focus();
        await page.keyboard.press("Enter");
        const t = await card.innerText();
        for (const s of [
          "6 / 18",
          "3 recovered",
          "ses-a06",
          "2026-08-01T00:00:00.000Z",
          "session-specific",
        ])
          check(t.includes(s), "D7 missing " + s);
        await card.screenshot({ path: `output/playwright/esf5/d7-${width}.png` });
        await page.keyboard.press("Escape");
        check(await launcher.evaluate((e) => e === document.activeElement), "D7 focus restoration");
        const menu = card.locator(".rec-actions-menu");
        if (await menu.getAttribute("open") === null) await menu.locator("summary").click();
        await card.getByRole("button", { name: "Evaluation", exact: true }).click();
        const evaluation = card.getByRole("region", { name: "Evaluation", exact: true });
        check((await evaluation.innerText()).includes("available after tracking starts"), "Native D7 tracking unavailable");
        await page.keyboard.press("Escape");
      },
    );
    const cards = page
      .locator(".rec-card")
      .filter({ has: page.locator("[data-testid=effect-evidence]") });
    for (let i = 0; i < (await cards.count()); i++) {
      const card = cards.nth(i);
      const e = await card.locator("[data-testid=effect-evidence]").first().innerText();
      const cycleId = e.match(/Frozen cycle ID: ([^.]+)\./)?.[1];
      const id = cycleId === "cycle-d4-01" ? "FX-LOWCOST-REPAIR"
        : cycleId === "cycle-d2-02" ? "FX-ROLLBACK-MID"
        : cycleId === "cycle-d8-03" ? "FX-MIX-DRIFT"
        : ["cycle-d7-04", "cycle-d2-05"].includes(cycleId) ? "FX-OVERLAP-SCOPED-14D"
        : ["cycle-d2-06", "cycle-d4-06"].includes(cycleId) ? "FX-OVERLAP-14D"
        : "FX-THRESHOLD-9-10:" + cycleId;
      await run(
        id,
        width,
        "Open evaluation; compare frozen evidence and available actions",
        "Collect more evidence; no success or savings conclusion",
        async () => {
          check(e.includes("Distinct sessions:"), "Sample denominator hidden");
          check(e.includes("Baseline window:"), "Window hidden");
          if (id === "FX-LOWCOST-REPAIR")
            for (const s of [
              "50 percentage_points",
              "68 percentage_points",
              "baseline value: 2",
              "Follow-up value: 5",
              "Denominator: 10",
              "adverse",
              "SYNTHETIC_SUPPLIED_GUARDRAIL_SEAM",
            ])
              check(e.includes(s), "Repair missing " + s);
          if (id === "FX-ROLLBACK-MID")
            for (const s of [
              "STOPPED",
              "2026-08-10T12:00:00.000Z",
              "CONFOUNDED",
              "ROLLBACK_IN_WINDOW",
            ])
              check(e.includes(s), "Rollback missing " + s);
          if (id === "FX-MIX-DRIFT")
            for (const s of [
              "6 / 20 turns (30%)",
              "11 / 20 turns (55%)",
              "MODEL_MIX_SHIFT",
              "MIX_UNASSESSED",
            ])
              check(e.includes(s), "Drift missing " + s);
          if (id === "FX-OVERLAP-14D" || id === "FX-OVERLAP-SCOPED-14D") {
            check(e.includes("OVERLAPPING_INTERVENTION") && e.includes("CONFOUNDED"), "Overlap explanation missing");
            check(e.includes("2026-08-17T00:00:00.000Z"), "Scheduled overlap boundary missing");
          }
          if (id === "FX-OVERLAP-SCOPED-14D") {
            check(/Frozen cycle ID: cycle-d[27]-0[45]\./.test(e), "Scoped literal ID missing");
            check(/Source identity: [0-9a-f]{64}\./.test(e) && /Tool: [0-9a-f]{64}\./.test(e), "Opaque frozen scope missing");
            check(e.includes("completed-tool-error-rate") && e.includes("strict-test-recovery-sequences"), "Scoped guardrails missing");
            check(e.includes("interruption-burden: unsupported"), "Unsupported interruptions misrepresented");
          }
          if (cycleId?.endsWith("-09") || cycleId?.endsWith("turn-trap"))
            check(e.includes("INSUFFICIENT_SESSIONS"), "Insufficient sample not disclosed");
          if (cycleId?.endsWith("-10")) {
            check(!e.includes("INSUFFICIENT_SESSIONS"), "Ten-session gate incorrectly failed");
            check((e.match(/Distinct sessions: 10\./g) ?? []).length === 2, "Ten-session cohort missing");
            const denominators = [...e.matchAll(/(?:Baseline|Follow-up) evidence:.*?Denominator: ([\d,.]+)\./g)].map(match => Number(match[1].replaceAll(",", "")));
            check(denominators.length === 2 && denominators.every(value => value > 0), "Valid metric-specific denominators missing");
          }
          const menu = card.locator(".rec-actions-menu");
          if ((await menu.getAttribute("open")) === null) {
            await menu.locator("summary").focus();
            await page.keyboard.press("Enter");
          }
          const launcher = card.getByRole("button", { name: "Evaluation", exact: true });
          await launcher.focus();
          await page.keyboard.press("Enter");
          const region = card.getByRole("region", { name: "Evaluation", exact: true });
          await region.waitFor();
          check(
            (await region.innerText()).includes("Stop measurement"),
            "Stop explanation missing",
          );
          await page.keyboard.press("Escape");
          check(
            await launcher.evaluate((e) => e === document.activeElement),
            "Evaluation focus restoration",
          );
          if (["FX-LOWCOST-REPAIR", "FX-ROLLBACK-MID", "FX-MIX-DRIFT"].includes(id))
            await card
              .locator("[data-testid=effect-evidence]")
              .first()
              .screenshot({ path: `output/playwright/esf5/${id}-${width}.png` });
        },
      );
    }
    await run(
      "FX-STATE-MAP:layout",
      width,
      "Inspect viewport after evidence replay",
      "No outcome inference",
      async () => {
        check(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          "Horizontal overflow",
        );
      },
    );
  }
  return {
    reviewer: "automated synthetic browser reviewer; not human testing",
    window: "[2026-08-01,2026-08-15)",
    presetSelection: "not evaluated; harness supplies explicit window",
    rows,
  };
}

async (page) => {
  page.setDefaultTimeout(7000);
  const base = page.url().split("/").slice(0, 3).join("/");
  const rows = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const run = async (id, width, action, decision, fn) => {
    try {
      await fn();
      rows.push({ id, width, action, decision, status: "PASS" });
    } catch (error) {
      rows.push({ id, width, action, decision, status: "FAIL", failure: String(error).slice(0, 500) });
    }
  };
  const json = async (path) => {
    const response = await page.request.get(base + path);
    check(response.ok(), `Read failed: ${path} (${response.status()})`);
    return response.json();
  };
  const observed = page.locator('[data-testid="esf-session-observed-evidence"]');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date("2026-08-15T00:00:00Z"));
    for (let n = 1; n <= 18; n++) {
      const id = `ses-a${String(n).padStart(2, "0")}`;
      await run(`FX-RECOVER-18:${id}`, width, "Read session evidence and matching recommendation link", "Recovery is an observation; no task success inferred", async () => {
        await page.goto(`${base}/#/sessions/${id}`);
        await page.reload();
        await observed.getByText("This complete session includes data", { exact: false }).waitFor();
        const text = await observed.innerText();
        check(text.includes(id) && !text.includes("6 / 18"), "Wrong session cohort");
        check(text.includes(n <= 3 ? "then an observed later pass" : n <= 6 ? "repeated test failures observed" : "no repeated test-failure sequence observed"), "Sequence attribution differs");
        const drivers = (await json(`/api/sessions/${id}/drivers`)).data.drivers.filter(x => x.detector_id === "D7");
        const links = page.locator('[data-detector="D7"] a[data-rec-id]');
        check(drivers.length === (n <= 6 ? 1 : 0), "Unexpected API recommendation match");
        if (n <= 6) {
          await links.waitFor();
          check(await links.getAttribute("data-rec-id") === drivers[0].rec_id, "Link identity differs");
          check(await links.getAttribute("href") === `#/recommendations?focus=${encodeURIComponent(drivers[0].rec_id)}`, "Link destination differs");
        } else check(await links.count() === 0, "Unaffected session has recommendation link");
      });
    }
    for (let n = 1; n <= 5; n++) {
      const id = `ses-r0${n}`;
      await run(`FX-RESEARCH-NC:${id}`, width, "Read research session activity and exclusions", "No commit does not imply abandonment", async () => {
        await page.goto(`${base}/#/sessions/${id}`);
        await page.reload();
        await observed.getByText("This complete session includes data", { exact: false }).waitFor();
        const text = await observed.innerText();
        check(text.includes(n < 5 ? "Qualifying Bash/edit activity without an observed commit" : "Outside the no-commit activity cohort"), "Research exclusion differs");
        check(text.includes("does not infer task success"), "Outcome limit missing");
      });
    }
    await run("FX-LIVE-SPARSE:UNKNOWN-MUTATION", width, "Create an unreported record, explicitly save UNKNOWN, reload", "Explicit unknown feedback differs from skipped feedback", async () => {
      await page.goto(`${base}/#/workspaces/ws-live`);
      const records = page.getByRole("region", { name: "Local work records", exact: true });
      await records.getByRole("button", { name: "Create work record", exact: true }).click();
      const heading = records.getByRole("heading", { name: /^Work record / });
      await heading.waitFor();
      const id = (await heading.innerText()).replace("Work record ", "");
      check((await records.innerText()).includes("Feedback: UNREPORTED"), "New record not unreported");
      await records.getByRole("combobox", { name: "Reported outcome", exact: true }).selectOption("UNKNOWN");
      await records.getByRole("button", { name: "Save feedback", exact: true }).click();
      await records.getByText("Feedback: UNKNOWN.", { exact: false }).waitFor();
      await page.reload();
      await records.getByRole("button", { name: id, exact: true }).click();
      await records.getByText("Feedback: UNKNOWN.", { exact: false }).waitFor();
      const text = await records.innerText();
      check(!text.includes("Source: NONE"), "Saved feedback lost its source");
      check(text.includes("00000000-0000-4000-8000-000000000003"), "Skipped original record missing");
      const saved = (await json("/api/work-records?workspace_id=ws-live")).data;
      check(saved.find(x => x.work_record_id === id).current.outcome_state === "UNKNOWN", "Readback lost UNKNOWN");
      check(saved.find(x => x.work_record_id.endsWith("000003")).current.feedback_source === "NONE", "Skipped record mutated");
      await records.screenshot({ path: `output/playwright/esf5/unknown-${width}.png` });
    });
    await run("FX-IDENTITY:CARD-HISTORY-LEDGER", width, "Compare frozen cycle identities and scalar/guardrail text across surfaces", "Same cycle, scope and cohort; no promoted result", async () => {
      await page.goto(`${base}/#/recommendations`);
      await page.locator('.rec-card [data-testid="effect-evidence"]').first().waitFor();
      const cards = page.locator('.rec-adopted-row .rec-card');
      const expectedIds = ["cycle-d4-01", "cycle-d2-02", "cycle-d8-03", "cycle-d7-04", "cycle-d2-05", "cycle-d2-06", "cycle-d4-06", "cycle-threshold-d4-turn-trap", ...["d2", "d4", "d8"].flatMap(d => ["09", "10"].map(n => `cycle-threshold-${d}-${n}`))];
      const actualIds = [];
      for (const card of await cards.all()) {
        const evidence = card.locator('[data-testid="effect-evidence"]').first();
        const text = await evidence.innerText();
        const id = text.match(/Frozen cycle ID: ([^.]+)\./)?.[1];
        check(id, "Frozen ID missing");
        actualIds.push(id);
        const history = card.getByRole("region", { name: "Measurement history", exact: true });
        await history.locator('[data-testid="effect-evidence"]').first().waitFor();
        check(await history.locator('[data-testid="effect-evidence"]').first().innerText() === text, `History differs: ${id}`);
        const ledger = page.locator('.ledger-entry [data-testid="effect-evidence"]').filter({ hasText: `Frozen cycle ID: ${id}.` });
        await ledger.waitFor();
        check(await ledger.innerText() === text, `Ledger differs: ${id}`);
      }
      check(JSON.stringify(actualIds.sort()) === JSON.stringify(expectedIds.sort()), "Frozen cycle set differs");
      check(await page.locator('[data-testid="effect-evidence"] p').evaluateAll(nodes => nodes.every(el => el.scrollWidth <= el.clientWidth + 1)), "Evidence text clipped internally");
    });
    for (const id of ["cycle-d7-04", "cycle-d2-05", "cycle-d2-06", "cycle-d4-06"]) {
      await run(`FX-KEYBOARD:EVALUATION:${id}`, width, "Tab to card actions and Evaluation; Enter and Escape", "Scoped and workspace overlap controls are keyboard reachable", async () => {
        await page.goto(`${base}/#/recommendations`);
        await page.reload();
        const card = page.locator('.rec-adopted-row .rec-card').filter({ has: page.locator('[data-testid="effect-evidence"]').filter({ hasText: `Frozen cycle ID: ${id}.` }) });
        const summary = card.locator('details.rec-actions-menu > summary');
        await summary.waitFor();
        const tabTo = async (target) => {
          for (let n = 0; n < 250; n++) {
            await page.keyboard.press("Tab");
            if (await target.evaluate(el => el === document.activeElement)) return;
          }
          throw new Error(`Control unreachable by Tab: ${id}`);
        };
        await tabTo(summary);
        await page.keyboard.press("Enter");
        const evaluation = card.getByRole("button", { name: "Evaluation", exact: true });
        await tabTo(evaluation);
        await page.keyboard.press("Enter");
        await card.getByRole("region", { name: "Evaluation", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        check(await evaluation.evaluate(el => el === document.activeElement), "Evaluation focus not restored");
      });
    }
    await run("FX-KEYBOARD:TAB-ENTER-ESCAPE", width, "Tab from page start to disclosure, Enter, Escape, then Tab onward", "Evidence controls reachable without mouse or direct focus assignment", async () => {
      await page.goto(`${base}/#/workspaces/ws-alpha`);
      const panel = page.locator('[data-testid="esf-observation-evidence"]');
      const target = panel.getByRole("button", { name: "View evidence and limits", exact: true });
      await target.waitFor();
      let reached = false;
      for (let n = 0; n < 100; n++) {
        await page.keyboard.press("Tab");
        if (await target.evaluate(el => el === document.activeElement)) { reached = true; break; }
      }
      check(reached, "Disclosure not reachable in tab sequence");
      await page.keyboard.press("Enter");
      const heading = panel.getByRole("heading", { name: "Evidence and limits", exact: true });
      await heading.waitFor();
      check(await heading.evaluate(el => el === document.activeElement), "Heading focus missing");
      await page.keyboard.press("Tab");
      check(await page.evaluate(() => document.activeElement.tagName === "A"), "Evidence links not keyboard navigable");
      await page.keyboard.press("Escape");
      check(await target.evaluate(el => el === document.activeElement), "Focus restoration missing");
      await page.keyboard.press("Tab");
      check(!(await target.evaluate(el => el === document.activeElement)), "Focus did not advance");
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Horizontal overflow");
      await page.screenshot({ path: `output/playwright/esf5/workspace-full-${width}.png`, fullPage: true });
    });
  }
  return { reviewer: "automated synthetic browser replay", controlledResponses: false, rows };
}

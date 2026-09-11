// Controlled UI-state replay for the ESFV surfaces' new reads on the synthetic
// esfv-browser-server: delivery metrics, effect measurement history, saved cost
// reports. Loading / transport-failure / empty envelopes only; no fake data.
// Run: npx --package @playwright/cli playwright-cli -s=esfv run-code --filename scripts/validation/esfv-browser-states.mjs
async (page) => {
  const base = page.url().split("/").slice(0, 3).join("/");
  const rows = [];
  const installedRoutes = new Set();
  const pendingGates = [];
  page.setDefaultTimeout(9000);
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const record = async (id, width, action, decision, run) => {
    try {
      await run();
      rows.push({ id, width, action, decision, status: "PASS" });
    } catch (error) {
      rows.push({ id, width, action, decision, status: "FAIL", failure: String(error).slice(0, 400) });
    } finally {
      for (const release of pendingGates.splice(0)) await release();
      for (const pattern of installedRoutes) await page.unroute(pattern);
      installedRoutes.clear();
    }
  };
  const remove = async (pattern) => {
    await page.unroute(pattern);
    installedRoutes.delete(pattern);
  };
  let visitNo = 0;
  const visit = async (path) => {
    // One fresh document per state avoids aborting gated reads with a second reload.
    await page.goto(`${base}/?esfv-state=${++visitNo}#${path}`);
  };
  const failure = async (route, label) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: label, controlled: true }) });
  const routeFailure = async (pattern, label) => {
    await page.route(pattern, (route) => failure(route, label));
    installedRoutes.add(pattern);
  };
  const routeJson = async (pattern, mutate) => {
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: mutate(body) });
    });
    installedRoutes.add(pattern);
  };
  const routeGate = async (pattern) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const inFlight = new Set();
    await page.route(pattern, (route) => {
      const handled = gate.then(() => route.continue());
      inFlight.add(handled);
      return handled;
    });
    installedRoutes.add(pattern);
    // Drain intercepted requests before unroute or a new document can handle them.
    const drain = async () => {
      await release();
      await Promise.all(inFlight);
    };
    pendingGates.push(drain);
    return drain;
  };
  const waitText = (text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 9000 });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date("2026-08-15T00:00:00Z"));

    await record("DELIVERY-LOADING", width, "Delay the delivery-metrics read", "Wait; no delivery claim while loading", async () => {
      const pattern = "**/api/workspaces/*/delivery*";
      const release = await routeGate(pattern);
      await visit("/workspaces/ws-alpha");
      await page.locator('[aria-label="Loading delivery metrics"]').waitFor();
      await release();
      await page
        .locator("[data-testid=workspace-delivery-card]")
        .getByText("Commit-session rate", { exact: true })
        .waitFor();
      await remove(pattern);
    });

    await record("DELIVERY-ERROR", width, "Return a controlled delivery transport failure", "Delivery metrics are unavailable; no rate is fabricated", async () => {
      const pattern = "**/api/workspaces/*/delivery*";
      await routeFailure(pattern, "CONTROLLED_DELIVERY_FAILURE");
      await visit("/workspaces/ws-alpha");
      await waitText("Delivery metrics unavailable");
      const card = await page.locator("[data-testid=workspace-delivery-card]").innerText();
      check(!card.includes("Commit-session rate"), "Delivery KPIs render despite the failure");
      await remove(pattern);
    });

    await record("HISTORY-LOADING", width, "Delay the measurement-history read", "Wait; recommendation history is not yet available", async () => {
      const pattern = "**/api/esf/effects?*";
      const release = await routeGate(pattern);
      await visit("/recommendations");
      await waitText("Loading measurement history");
      await release();
      await page.locator("[data-testid=effect-evidence]").first().waitFor();
      await remove(pattern);
    });

    await record("HISTORY-ERROR-RETRY", width, "Return a controlled measurement-history failure then retry", "Retry the read; no measurement is fabricated", async () => {
      const pattern = "**/api/esf/effects?*";
      await routeFailure(pattern, "CONTROLLED_HISTORY_FAILURE");
      await visit("/recommendations");
      await waitText("Could not load measurement history");
      await remove(pattern);
      await page.getByRole("button", { name: "Retry loading history" }).first().click();
      await page.locator("[data-testid=effect-evidence]").first().waitFor();
    });

    await record("HISTORY-EMPTY", width, "Return a controlled empty measurement history", "No recorded measurement history in this controlled response", async () => {
      const pattern = "**/api/esf/effects?*";
      await routeJson(pattern, (body) => ({
        ...body,
        cycles: [],
        legacy: [],
        next_cycle_cursor: null,
        next_legacy_cursor: null,
      }));
      await visit("/recommendations");
      await waitText("No recorded measurement history.");
      await remove(pattern);
    });

    await record("REPORTS-LIST-ERROR", width, "Return a controlled saved-reports list failure", "Saved reports are UNAVAILABLE; no list is fabricated", async () => {
      const pattern = "**/api/work-records/allocations?*";
      await routeFailure(pattern, "CONTROLLED_ALLOCATION_LIST_FAILURE");
      await visit("/workspaces/ws-shared");
      const panel = page.getByLabel("Saved cost reports").first();
      await panel.getByRole("heading", { name: "Saved cost reports" }).waitFor();
      await panel.getByText("Saved reports are UNAVAILABLE.", { exact: false }).waitFor();
      check(
        (await panel.getByRole("alert").count()) > 0,
        "List failure is not announced as an alert",
      );
      await remove(pattern);
    });

    await record("LAYOUT", width, "Inspect controlled-state layout", "No horizontal overflow", async () => {
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Horizontal overflow");
    });
  }
  const report = {
    reviewer: "automated controlled browser replay; synthetic server only",
    server: base,
    writes: "none",
    controlledResponses: "transport failure, empty envelope, or delayed real synthetic response",
    rows,
  };
  console.log(JSON.stringify(report));
  return report;
}

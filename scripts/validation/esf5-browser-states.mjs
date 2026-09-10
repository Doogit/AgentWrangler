// Controlled UI-state replay for the existing ESF5 synthetic browser server.
// Run with: playwright-cli --session esf5-states open <ESF5 synthetic URL>
// then: playwright-cli --session esf5-states run-code "$(Get-Content -Raw scripts/validation/esf5-browser-states.mjs)"
// Replacements use existing synthetic rows, empty envelopes, or labelled failures.
async (page) => {
  const base = page.url().split("/").slice(0, 3).join("/");
  const rows = [];
  const installedRoutes = new Set();
  const pendingGates = [];
  page.setDefaultTimeout(7000);
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
    await page.goto(`${base}/?esf5-state=${++visitNo}#${path}`);
    if (path === "/") await page.locator('[data-testid="overview-data-notes"] > summary').click();
  };
  const json = async (route, mutate) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: mutate(body) });
  };
  const nullData = (body) => ({ ...body, data: null });
  const failure = async (route, label) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: label, controlled: true }) });
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
  const routeNull = async (pattern) => {
    await page.route(pattern, (route) => json(route, nullData));
    installedRoutes.add(pattern);
  };
  const routeFailure = async (pattern, label) => {
    await page.route(pattern, (route) => failure(route, label));
    installedRoutes.add(pattern);
  };
  const routeJson = async (pattern, mutate) => {
    await page.route(pattern, (route) => json(route, mutate));
    installedRoutes.add(pattern);
  };
  const routeResponse = async (pattern, handler) => {
    await page.route(pattern, handler);
    installedRoutes.add(pattern);
  };
  const body = () => page.locator("body").innerText();
  const waitText = (text) => page.getByText(text, { exact: false }).waitFor({ timeout: 7000 });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });

    await record("INTERRUPTS-LEGACY-UNSUPPORTED", width, "Replay a legacy session with stored interrupt zero and no support flag", "Interrupt telemetry is unavailable, not an observed zero", async () => {
      const pattern = "**/api/sessions/ses-a01";
      await routeJson(pattern, (body) => {
        const data = { ...body.data, interrupt_count: 0 };
        delete data.interrupts_supported;
        return { ...body, data };
      });
      await visit("/sessions/ses-a01");
      await page.getByText("Unavailable (legacy zero is unsupported)", { exact: true }).waitFor();
    });

    await record("OBS-OVERVIEW-LOADING", width, "Delay global observation response", "Wait; no observation claim while loading", async () => {
      const pattern = "**/api/esf/observations?*";
      const release = await routeGate(pattern);
      await visit("/");
      await page.locator("[data-testid=esf-observation-evidence] [aria-busy=true]").waitFor();
      await release();
      await page.locator("[data-testid=esf-observation-evidence]").getByRole("button", { name: "View evidence and limits", exact: true }).waitFor();
      await remove(pattern);
    });

    await record("OBS-OVERVIEW-ERROR-RETRY", width, "Return controlled observation failure then retry", "Retry the read; do not infer unavailable data", async () => {
      const pattern = "**/api/esf/observations?*";
      await routeFailure(pattern, "CONTROLLED_OBSERVATION_FAILURE");
      await visit("/");
      await waitText("Observation request failed");
      check((await body()).includes("Retry"), "Overview observation retry is absent");
      await remove(pattern);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.locator("[data-testid=esf-observation-evidence]").getByRole("button", { name: "View evidence and limits", exact: true }).waitFor();
    });

    await record("OBS-OVERVIEW-EMPTY", width, "Return a controlled empty observation envelope", "No eligible observations in the selected window", async () => {
      const pattern = "**/api/esf/observations?*";
      await routeNull(pattern);
      await visit("/");
      await waitText("No eligible observations in this window.");
      await remove(pattern);
    });

    await record("OBS-WORKSPACE-EMPTY", width, "Return a controlled empty workspace cohort", "No eligible workspace observations", async () => {
      const pattern = "**/api/esf/observations?*workspace_id=**";
      await routeNull(pattern);
      await visit("/workspaces/ws-alpha");
      await waitText("No eligible observations in this window.");
      await remove(pattern);
    });

    await record("OBS-SESSION-UNAVAILABLE-RETRY", width, "Return a controlled unavailable session envelope then retry", "Session evidence unavailable until a later read succeeds", async () => {
      const pattern = "**/api/esf/session-observations/**";
      await routeNull(pattern);
      await visit("/sessions/ses-a01");
      await waitText("Session evidence unavailable.");
      await remove(pattern);
      await visit("/sessions/ses-a01");
      await page.locator("[data-testid=esf-session-observed-evidence]").getByText("This complete session includes data", { exact: false }).waitFor();
    });

    await record("OBS-SESSION-ERROR-RETRY", width, "Return a controlled session transport failure then retry", "Retry the read; no unsupported observation is fabricated", async () => {
      const pattern = "**/api/esf/session-observations/**";
      await routeFailure(pattern, "CONTROLLED_SESSION_OBSERVATION_FAILURE");
      await visit("/sessions/ses-a01");
      await waitText("Session observation request failed");
      await remove(pattern);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.locator("[data-testid=esf-session-observed-evidence]").getByText("This complete session includes data", { exact: false }).waitFor();
    });

    await record("RECS-LOADING", width, "Delay recommendations and ledger reads", "Wait; recommendation history is not yet available", async () => {
      const recPattern = "**/api/recommendations";
      const ledgerPattern = "**/api/recommendations/ledger";
      const releaseRecommendations = await routeGate(recPattern);
      const releaseLedger = await routeGate(ledgerPattern);
      await visit("/recommendations");
      await page.getByLabel("Loading recommendations").waitFor();
      await releaseRecommendations();
      await releaseLedger();
      await page.getByRole("heading", { name: "Recommendations" }).waitFor();
      await remove(recPattern);
      await remove(ledgerPattern);
    });

    await record("RECS-ERROR", width, "Return a controlled recommendation history failure", "History is unavailable; no action is attempted", async () => {
      const pattern = "**/api/recommendations";
      await routeFailure(pattern, "CONTROLLED_RECOMMENDATIONS_FAILURE");
      await visit("/recommendations");
      await waitText("Daemon unreachable");
      await remove(pattern);
    });

    await record("RECS-EMPTY", width, "Return a controlled empty recommendation history", "No active, adopted, or dismissed history in this controlled response", async () => {
      const pattern = "**/api/recommendations";
      await routeJson(pattern, (body) => ({
        ...body,
        data: body.data === null ? null : { ...body.data, active: [], active_groups: [], limit_warnings: [], adopted: [], dismissed: [] },
      }));
      await visit("/recommendations");
      await waitText("No active recommendations");
      await remove(pattern);
    });

    await record("EVALUATION-EXISTING-CONTROL", width, "Open a real synthetic evaluation disclosure", "Read frozen evidence only; do not start or stop measurement", async () => {
      await visit("/recommendations");
      const card = page.locator(".rec-card").filter({ has: page.locator("[data-testid=effect-evidence]") }).first();
      await card.waitFor();
      await card.locator("details.rec-actions-menu > summary").click();
      const button = card.getByRole("button", { name: "Evaluation", exact: true });
      await button.click();
      await card.getByRole("region", { name: "Evaluation", exact: true }).waitFor();
      check((await card.innerText()).includes("Stop measurement"), "Evaluation disclosure lacks its stop explanation");
      await page.keyboard.press("Escape");
    });

    await record("LEDGER-ERROR-RETRY", width, "Return a controlled ledger failure then retry", "Ledger unavailable; retry read without making a measurement", async () => {
      const pattern = "**/api/recommendations/ledger";
      await routeFailure(pattern, "CONTROLLED_LEDGER_FAILURE");
      await visit("/recommendations");
      await waitText("Impact Ledger unavailable");
      await remove(pattern);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.locator(".impact-ledger .ledger-entry").first().waitFor();
      check(!(await page.locator(".impact-ledger").innerText()).includes("Impact Ledger unavailable"), "Ledger retry did not recover");
    });

    await record("LEDGER-EMPTY", width, "Return a controlled empty ledger history", "No tracked completed changes in this controlled response", async () => {
      const pattern = "**/api/recommendations/ledger";
      await routeJson(pattern, (body) => ({ ...body, data: body.data === null ? null : { ...body.data, entries: [] } }));
      await visit("/recommendations");
      await waitText("No tracked completed changes in this scope.");
      await remove(pattern);
    });

    await record("WORK-LOADING-UNAVAILABLE", width, "Delay then return controlled reported-work unavailability", "Reported work is unavailable; no record count is claimed", async () => {
      const pattern = "**/api/work-records/summary?*";
      const release = await routeGate(pattern);
      await visit("/workspaces/ws-alpha");
      await page.getByLabel("Useful work reported").getByText("Loading reported work", { exact: false }).waitFor();
      await release();
      await remove(pattern);
      await routeFailure(pattern, "CONTROLLED_REPORTED_WORK_UNSUPPORTED");
      await visit("/workspaces/ws-alpha");
      await waitText("Reported work unavailable.");
      await remove(pattern);
    });

    await record("WORK-ERROR-RETRY", width, "Return a controlled reported-work error then retry", "Retry the reported-work read", async () => {
      const pattern = "**/api/work-records/summary?*";
      await routeResponse(pattern, (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
      await visit("/workspaces/ws-alpha");
      await waitText("Reported work request failed.");
      await remove(pattern);
      await page.getByRole("button", { name: "Retry reported work", exact: true }).click();
      await page.getByLabel("Useful work reported").getByText("Current retained records", { exact: false }).waitFor();
    });

    await record("LAYOUT", width, "Inspect controlled-state layout", "No horizontal overflow", async () => {
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Horizontal overflow");
    });
  }
  const report = {
    reviewer: "automated controlled browser replay; synthetic server only",
    server: base,
    writes: "none",
    controlledResponses: "transport failure, empty envelope, or existing synthetic session with legacy unsupported interrupt zero",
    rows,
  };
  console.log(JSON.stringify(report));
  return report;
}

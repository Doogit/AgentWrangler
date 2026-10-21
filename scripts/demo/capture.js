// Run from the repository root after starting Vite test mode on loopback port 47841:
// npx --package @playwright/cli playwright-cli -s=demo-usage run-code --filename scripts/demo/capture.js
// Create output/playwright/demo-usage/raw (or raw-dark) first. This performs no backend writes.
// Captures the LIGHT theme by default. Edit ONLY to choose which shots to (re)take.
// THEME = 'dark' captures every shot into raw-dark/ for the dark set (python scripts/demo/compose.py --theme dark).
async (page) => {
  const THEME = 'light';
  // Names to capture. Remove a name to skip it (e.g. overview/settings/ledger until those pages are final).
  const LIGHT_ONLY = new Set([
    'overview', 'workspace-detail', 'sessions', 'session-detail', 'judge-setup', 'usage-patterns',
    // dashboard.gif scenes (compose.py builds the reel only when all of these exist):
    'overview-limits', 'workspaces', 'recommendation-detail', 'recommendation-evidence', 'ledger',
    // 'settings', 'recommendations', 'glossary', 'help',
  ]);
  const ONLY = THEME === 'dark' ? {has: () => true} : LIGHT_ONLY;
  const base = 'http://127.0.0.1:47841/';
  const out = THEME === 'dark' ? 'output/playwright/demo-usage/raw-dark' : 'output/playwright/demo-usage/raw';
  await page.setViewportSize({width:1440,height:1100});
  // The fixture is a deterministic historical sample, including relative-time labels.
  await page.clock.setFixedTime(new Date('2026-08-24T00:00:00.000Z'));
  const shot = async (name) => {
    if (!ONLY.has(name)) return;
    await page.evaluate(() => document.fonts.ready);
    // Clicking the theme toggle leaves keyboard-style focus rings on route headings; drop focus.
    await page.evaluate(() => document.activeElement?.blur());
    // Allow count-up values and chart entrance transitions to reach their final state.
    await page.waitForTimeout(2000);
    await page.screenshot({path:`${out}/${name}.png`, animations:'disabled'});
  };
  const navigate = async (route, heading) => {
    await page.goto(`${base}#/${route}`);
    await page.getByRole('heading',{name:heading,exact:true}).first().waitFor();
    await page.evaluate(() => window.scrollTo(0,0));
  };

  // Test mode has no mock for /api/overview-view; serve the fixture module's mockOverviewView
  // (loaded through Vite in the page), keeping only the requested sections.
  await page.route('**/api/overview-view?*', async r => {
    const u = new URL(r.request().url());
    const json = await page.evaluate(async ([preset, sections]) => {
      const full = (await import('/api/fixtures.ts')).mockOverviewView(preset);
      if (!sections) return full;
      const picked = {};
      for (const s of sections.split(',')) if (full.sections[s] !== undefined) picked[s] = full.sections[s];
      return {...full, sections: picked};
    }, [u.searchParams.get('preset') ?? '7d', u.searchParams.get('sections')]);
    await r.fulfill({json});
  });

  await navigate('workspaces','Workspaces');
  // The toggle is labelled with the theme it switches TO. Only click when not already in THEME.
  const other = THEME === 'dark' ? 'light' : 'dark';
  const toTheme = page.getByRole('button',{name:`Switch to ${THEME} theme`,exact:true});
  if (await toTheme.count()) await toTheme.click();
  await page.getByRole('button',{name:`Switch to ${other} theme`,exact:true}).waitFor();

  if (ONLY.has('overview') || ONLY.has('overview-limits')) {
    await navigate('overview','Overview');
    const costly = page.getByRole('link',{name:'Most expensive sessions this week',exact:true});
    await costly.waitFor();
    await shot('overview');
    await costly.evaluate(el => { el.scrollIntoView({block:'start'}); window.scrollBy(0,-24); });
    await shot('overview-limits');
  }

  const wsLink = page.locator('a.workspace-row-link',{hasText:'acme/orbit-api'}).first();
  await navigate('workspaces','Workspaces');
  await wsLink.waitFor();
  await shot('workspaces');
  await wsLink.click();
  await page.getByRole('heading',{name:'Where tokens went',exact:true}).waitFor();
  await page.getByRole('region',{name:'Context composition'}).first().waitFor();
  await page.getByRole('heading',{name:'Observed delivery proxy',exact:true}).waitFor();
  await page.getByText('sessions with an observed commit').first().waitFor();
  await page.evaluate(() => window.scrollTo(0,0));
  await shot('workspace-detail');

  await navigate('sessions','Sessions');
  const firstSession = page.getByRole('link',{name:/^Open session /}).first();
  await firstSession.waitFor();
  await shot('sessions');
  await firstSession.click();
  await page.getByRole('heading',{name:/Cost drivers/}).waitFor();
  await shot('session-detail');

  await navigate('recommendations','Recommendations');
  await page.getByLabel('Active recommendations summary',{exact:true}).waitFor();
  await shot('recommendations');
  if (ONLY.has('recommendation-detail') || ONLY.has('recommendation-evidence')) {
    // Select the same workspace recommendation displayed on Overview.
    await page.goto(`${base}#/recommendations?focus=rec-D1-ws-1-mock000000000000`);
    await page.getByText("Trim stale instructions from this workspace's CLAUDE.md.",{exact:true}).first().waitFor();
    await page.evaluate(() => window.scrollTo(0,0));
    await shot('recommendation-detail');
    // The focused card opens expanded; only click Show details if it did not.
    const evidence = page.getByRole('heading',{name:'Recommendation details'}).first();
    if (!(await evidence.isVisible())) await page.getByRole('button',{name:/Show details/}).first().click();
    await evidence
      .evaluate(el => { el.scrollIntoView({block:'start'}); window.scrollBy(0,-24); });
    await shot('recommendation-evidence');
  }
  if (ONLY.has('ledger')) {
    await navigate('recommendations','Recommendations');
    await page.getByRole('heading',{name:/Adopted changes/}).first()
      .evaluate(el => { el.scrollIntoView({block:'start'}); window.scrollBy(0,-24); });
    await shot('ledger');
  }

  // Test mode has no mock for the judge verdict route; answer it with the honest "no review
  // written yet" state (browser-side only; nothing reaches a daemon).
  await page.route('**/api/judge-setup/verdict', r => r.fulfill({json:{verdict:null,remembered:false}}));

  await navigate('judge-setup','Rate my setup');
  await page.getByText('Judge me',{exact:true}).first().waitFor();
  await shot('judge-setup');
  await navigate('diagnostics','Usage patterns');
  await page.getByLabel('Usage patterns tiles').waitFor();
  await shot('usage-patterns');
  if (ONLY.has('settings')) {
    await page.goto(`${base}#/settings`);
    await page.getByRole('heading',{level:1}).first().waitFor();
    // Bring the "Usage limits from Claude Code" setting and the statusline panel into view.
    await page.getByText('Usage limits from Claude Code').first()
      .evaluate(el => { el.scrollIntoView({block:'start'}); window.scrollBy(0,-300); });
    await shot('settings');
  }
  await navigate('glossary','How to read this dashboard');
  await shot('glossary');
  await navigate('help','Help');
  await shot('help');
}

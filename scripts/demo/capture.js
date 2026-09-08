// Run from the repository root after starting Vite test mode on loopback port 47841:
// npx --package @playwright/cli playwright-cli -s=demo-usage run-code --filename scripts/demo/capture.js
// Create output/playwright/demo-usage/raw first. This performs no backend writes.
async (page) => {
  const base = 'http://127.0.0.1:47841/';
  const out = 'output/playwright/demo-usage/raw';
  await page.setViewportSize({width:1440,height:1100});
  // The fixture is a deterministic historical sample, including relative-time labels.
  await page.clock.setFixedTime(new Date('2026-08-24T00:00:00.000Z'));
  const shot = async (name) => {
    await page.evaluate(() => document.fonts.ready);
    // Allow count-up values and chart entrance transitions to reach their final state.
    await page.waitForTimeout(2000);
    await page.screenshot({path:`${out}/${name}.png`, animations:'disabled'});
  };
  const navigate = async (route, heading) => {
    await page.goto(`${base}#/${route}`);
    await page.getByRole('heading',{name:heading,exact:true}).waitFor();
    await page.evaluate(() => window.scrollTo(0,0));
  };
  await navigate('overview','Overview');
  const darkTheme = page.getByRole('button',{name:'Switch to dark theme',exact:true});
  if (await darkTheme.count()) await darkTheme.click();
  await page.getByRole('region',{name:'Usage this period',exact:true}).waitFor();
  await shot('overview');
  await page.getByText('HOT SESSIONS',{exact:true}).evaluate(el => el.closest('[data-testid="rv7-tile-row"]').scrollIntoView({block:'start'}));
  await shot('overview-limits');
  await navigate('workspaces','Workspaces');
  await page.getByRole('row',{name:/Open acme\/orbit-api workspace detail/}).waitFor();
  await shot('workspaces');
  await page.getByRole('row',{name:/Open acme\/orbit-api workspace detail/}).click();
  await page.getByText('Context composition',{exact:true}).waitFor();
  await shot('workspace-detail');
  await navigate('sessions','Sessions');
  const firstSession = page.getByRole('button',{name:/Copy and open session/}).first();
  await firstSession.waitFor();
  await shot('sessions');
  await firstSession.click();
  await page.getByRole('heading',{name:/Cost drivers/}).waitFor();
  await shot('session-detail');
  await navigate('recommendations','Recommendations');
  await page.getByLabel('Active recommendations summary',{exact:true}).waitFor();
  await shot('recommendations');
  // Select the same workspace recommendation displayed on Overview.
  await page.goto(`${base}#/recommendations?focus=rec-D1-ws-1-mock000000000000`);
  await page.getByRole('heading',{name:"Trim stale instructions from this workspace's CLAUDE.md.",exact:true}).waitFor();
  await shot('recommendation-detail');
  const details=page.getByRole('button',{name:'Show details',exact:true}).first();
  if(await details.isVisible()) await details.click();
  await page.getByRole('heading',{name:'Why this is ranked here',exact:true}).evaluate(el => { el.scrollIntoView({block:'start'}); window.scrollBy(0,-24); });
  await shot('recommendation-evidence');
  await navigate('recommendations','Recommendations');
  await page.getByRole('heading',{name:/Adopted changes/}).evaluate(el => { el.scrollIntoView({block:'start'}); window.scrollBy(0,-24); });
  await shot('ledger');
  await navigate('briefs','Briefs');
  await page.getByRole('button',{name:/Copy as markdown/i}).first().waitFor();
  await shot('briefs');
  await navigate('settings','Settings');
  await page.getByRole('heading',{name:'Configuration',exact:true}).waitFor();
  await shot('settings');
  await navigate('glossary','How to read this dashboard');
  await shot('glossary');
}

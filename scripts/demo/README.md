# Reproduce synthetic demo media

Prerequisites: project dependencies, Python with Pillow, Playwright CLI and its browser.
Run from the repository root. Use an unused loopback port; this script expects 47841.

```powershell
New-Item -ItemType Directory -Force output/playwright/demo-usage/raw
npx vite --mode test --host 127.0.0.1 --port 47841 --strictPort
```

In another terminal:

```powershell
npx --package @playwright/cli playwright-cli -s=demo-usage open http://127.0.0.1:47841
npx --package @playwright/cli playwright-cli -s=demo-usage run-code --filename scripts/demo/capture.js
python scripts/demo/compose.py
```

The capture uses the actual UI in the light theme and fixes the clock to August 24, 2026,
just after the historical fixture week. It makes no backend writes. Edit the `ONLY` list at
the top of `capture.js` to choose which shots to retake (the rest keep their current PNG).
Test mode has no mock for the judge-verdict route, so `capture.js` answers it with a small
synthetic payload inside the browser (diagnostics and workspace delivery have test-mode mocks). The compositor adds an external
synthetic-data footer to every captured screenshot in `docs/assets/` (up to eleven) and,
when all reel shots exist, prepares seven captioned frames plus
`output/playwright/demo-usage/storyboard.json`.

Use the Codex `demo-reel` skill's `scripts/build_reel.py` with that manifest and a new
output directory to build the optional GIF, contact sheet and paused HTML review player.
Inspect every screenshot and scene, then copy the reviewed `demo.gif` to
`docs/assets/dashboard.gif`. The first six scenes show investigation; the ledger is a
separate seeded example, not a result of a change made in this walkthrough.

Raw captures and review artifacts stay in ignored `output/`. The public PNGs and GIF
contain only synthetic data. Stop the browser session and the Vite process you started:

```powershell
npx --package @playwright/cli playwright-cli -s=demo-usage close
```

Stop Vite with Ctrl+C in its terminal. No media is uploaded by these helpers.

Dark set (Reddit post only, not exported): copy `capture.js` into `output/`, set `THEME = 'dark'`
in the copy, create `output/playwright/demo-usage/raw-dark`, run the copy, then
`python scripts/demo/compose.py --theme dark`. It captures every shot and writes the labelled PNGs to
`docs/launch/reddit/dark/` and the reel scenes to `output/playwright/demo-usage/dark/`. Build the GIF
from `dark/storyboard.json` as above and copy it to `docs/launch/reddit/dark/dashboard.gif`.

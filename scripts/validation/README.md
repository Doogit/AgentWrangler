# Package and workflow acceptance

## Exact local package

After `npm ci` (or `npm run build` following edits), run:

```sh
node scripts/validation/package-smoke.mjs
```

This packs the already built checkout without publishing, checks the tarball inventory,
and invokes that exact tarball through `npm exec --package <tarball> -- agentwrangler
--smoke --no-open` (the `npx` execution path). It uses a temporary home, empty npm configs,
fresh dependency cache, empty scan root and new database. Registry access installs runtime
dependencies. The JSON result includes the tarball SHA256, version, platform, Node version
and verified table count. It removes its temporary directory after the npm processes exit.

This proves packaging, compiled CLI execution, native SQLite loading and migration startup.
It does not start collectors or prove HTTP, authentication, native accessibility or GUI workflows.
The separate `package-smoke` CI matrix runs on Windows, Linux and macOS with Node 22.
An unexecuted workflow is not evidence that its platforms passed.

## Synthetic browser workflow

Use a dedicated test-mode Vite instance on an unused loopback port, for example:

```sh
npx vite --mode test --host 127.0.0.1 --port 47827 --strictPort
```

Keep the operator daemon and real settings separate. API fixtures are synthetic, but any
action calling a write endpoint must be stubbed at the browser boundary before clicking it.
Never install hooks or launch an external agent to validate the recipe.

- In a fresh browser profile, follow the README scan/session/recommendation recipe. Check
  Overview, workspace detail, session detail and trends describe the same selected window.
- Exercise no data, multiple workspaces/families, failed and pending writes. A failed write
  must not create an adopted ledger row; a pending one must not claim completion.
- On a source-backed D1 instance, copy the prompt, attest completion, then track. Copying
  alone changes no files and does not adopt. Use controlled API responses and clocks to
  show measuring, EFFECTIVE, NO_EFFECT (including an unfavorable raw delta), and INCONCLUSIVE.
- A D5 warning is acknowledged, with no measurement deadline or savings claim.
- Navigate by keyboard in both themes. Inspect loading/error recovery and narrow widths.
  For native zoom, use browser zoom at 200% and verify the actual zoom changed; CSS scaling,
  viewport emulation and unchanged headless shortcut results do not count.
- With a native screen reader, verify navigation landmarks, family/instance expand controls,
  action progress/errors and ledger verdicts are announced. A DOM accessibility snapshot
  alone does not establish this check.

Record revision, platform/browser, scenario, result and unverified cases in the governing
acceptance record. Keep screenshots/logs local under `output/`; public media must use only
synthetic data. Stop only the test services and browser session created for the check.

The existing `stranger-smoke` workflow covers source-install HTTP startup on Linux/macOS.
Keep its evidence distinct from the exact-tarball smoke above and the native manual checks.

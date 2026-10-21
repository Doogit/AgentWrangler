C11 fixtures. Positive = golden gs-c11-mcpcap (2 MCP over-cap errors, main chain; card needs any 1, no gates).
Near miss: minimum capped-call errors, operator at least 1 (no named constant on the card). Positive has 2 over-cap
errors; near miss keeps the same turn and calls but both results succeed ("ok"), so 0 errors (one below 1).

## near-miss-sidechain
Card clause (Trigger): "At least one tool call on the main chain ... whose error was classified as MCP content too
large"; Inputs list the owning turn's sidechain flag. This case is the positive's exact shape (same 2 MCP over-cap
errors, same turn, same session) with ONE change: the owning turn and its result line carry isSidechain:true. The
over-cap errors are real but off the main chain, so they are excluded and the detector must stay silent.
Mutant targets: dropping/inverting the main-chain filter turns this case RED (fires).

## Mutants (list only, not run)
- Minimum capped-call errors, 1 per session: shift ">= 1" to ">= 3". Positive (2 errors) goes RED. (">= 2" stays green.)
- Main-chain scope (sidechain exclusion): remove the sidechain filter. near-miss-sidechain goes RED.
- Settled-turn requirement (provisional excluded): not covered by a case here; no mutant claimed.

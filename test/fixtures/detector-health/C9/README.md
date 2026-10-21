C9 fixtures. Positive = golden gs-c9-denials (hook-block, deny-rule, user-rejected on main chain; no AskUserQuestion; card
needs any 1 event, no gates).
Near miss: minimum denial events, operator at least 1 (no named constant on the card). Positive has 3 denial events; near
miss keeps the same turn and tool calls but all three results succeed ("ok"), so 0 events (one below 1). The
toolDenialKind marker is removed with the denied result.

Near miss 2 (near-miss-sidechain): card Trigger clause "on the main chain (not a subagent)". Identical to the positive
(same three denials: hook-block, deny-rule, user-rejected) except every line carries isSidechain:true, so all three
denial events are sidechain and excluded. Expect silent.
Mutant: dropping/inverting the sidechain exclusion makes this case fire (RED).

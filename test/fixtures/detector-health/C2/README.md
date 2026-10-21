# C2 fixtures

Positive: golden `gs-c2-notfound` (unchanged). Card clauses met: 4 Read/Grep tool calls with NOT_FOUND-style errors on a main-chain turn; no minimum count.

Near miss: constant `tool_name` (set Read, Grep, Glob; C2 counts only these tools).
Positive tools = Read x3 + Grep x1; near miss = Bash x4 with identical error texts and identical turn. Only the tool name (and its input) changed, so the same NOT_FOUND-style errors fall outside the tool set.

# D14 fixtures

- Positive: golden `gs-d14-interrupt` (a pure interrupt and a cancelled/killed call on one main-thread turn, no later user prompt). Meets the card: no good-interrupt exclusion.
- Near miss: same file plus 2 later assistant turns and then a typed user prompt. Constant "later main turns before user prompt" (<= 2 is excluded as a good interrupt): positive has no prompt, near miss has exactly 2 turns before the prompt (at the threshold). A trailing assistant turn follows the prompt.

# D7 fixtures

- Positive: golden `gs-c5-errorloop` (3 consecutive failed Edit calls, same error, 2 s apart, gaps <= 120 s). Meets card signal 5 (MIN_RUN >= 3, MAX_RUN_GAP_SEC 120).
- Near miss: same file with the third Edit/result pair dropped. Constant `MIN_RUN` (run length >= 3): positive 3, near miss 2 (one below).

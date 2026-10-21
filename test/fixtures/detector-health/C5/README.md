C5 fixtures. Positive = golden gs-c5-errorloop (3 identical Edit errors on 3 distinct main-chain turns, 2 s apart, not benign
or denial; meets card trigger, no gates).
Near miss: C5_MIN_IDENTICAL_ERRORS, operator >=, value 3. Positive has 3 turns; near miss drops turn t3 (and its result),
leaving 2 (one below 3). Gap constant C5_MAX_RETRY_GAP_MS untouched.

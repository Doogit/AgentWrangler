// The app's TanStack QueryClient is a module singleton (src/ui/api/query-client.ts). Pages pass it
// to useQuery directly, so tests render them without a provider. Mount it once, as main.tsx's
// QueryClientProvider does (focus / reconnect refetches subscribe here), and clear it after every
// test so one test's cached page response never renders in the next (P1-U4).
import { afterEach } from "vitest";
import { queryClient } from "../../src/ui/api/query-client";
import { resetSessionToken } from "../../src/ui/api/session-token";

queryClient.mount();

afterEach(() => {
  queryClient.clear();
  // P1-U6a: the session token is kept for the page's life; each test is a fresh page.
  resetSessionToken();
});

import "./styles.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { queryClient } from "./api/query-client";
import { initTheme } from "./lib/theme";
import RootBoundary from "./shell/RootBoundary";

initTheme();

const foundRoot = document.getElementById("root");
if (!foundRoot) throw new Error("No #root element found");
const rootEl: HTMLElement = foundRoot;

// P1-U5: mount at once, before the daemon is ready. #root is empty in index.html (the
// pre-JS paint lives in the sibling #boot-overlay), so createRoot has nothing to wipe.
// App removes the overlay on its first commit; boot progress lives in the shell's
// StatusChip, and pages render their own skeletons until their data arrives.
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RootBoundary>
        <App />
      </RootBoundary>
    </QueryClientProvider>
  </StrictMode>,
);

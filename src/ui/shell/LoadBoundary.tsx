import { Component, type ReactNode, Suspense } from "react";
import AsyncErrorState from "./AsyncErrorState";

function getLoadingLabel(label: string): string {
  if (label === "page") return "page";
  if (label === "trends") return "trends";
  return "content";
}

/** Keep navigation available when a route or chart chunk fails to load. */
export default class LoadBoundary extends Component<
  { children: ReactNode; label: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    const { children, label } = this.props;
    const loadingLabel = getLoadingLabel(label);
    if (this.state.failed) {
      return (
        <AsyncErrorState
          resource="route-page"
          onRetry={() => window.location.reload()}
          action="reload-dashboard"
        />
      );
    }
    return (
      <Suspense
        fallback={
          <output className="load-boundary-skeleton" aria-label={`Loading ${loadingLabel}`}>
            Loading {loadingLabel}…
          </output>
        }
      >
        {children}
      </Suspense>
    );
  }
}

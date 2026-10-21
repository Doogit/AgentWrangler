import { Component, type ReactNode } from "react";
import AsyncErrorState from "./AsyncErrorState";

interface RootBoundaryState {
  failed: boolean;
}

/**
 * Last-resort boundary around the whole app shell. A throw in a root-level
 * sibling that sits outside LoadBoundary's route tree (Sidebar,
 * PipelineStatusBar) would otherwise leave #root blank; this shows a reload
 * card instead.
 */
export default class RootBoundary extends Component<{ children: ReactNode }, RootBoundaryState> {
  state: RootBoundaryState = { failed: false };

  static getDerivedStateFromError(): Partial<RootBoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("[root-boundary]", error);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="shell">
          <AsyncErrorState
            resource="route-page"
            onRetry={() => window.location.reload()}
            action="reload-dashboard"
          />
        </div>
      );
    }
    return this.props.children;
  }
}

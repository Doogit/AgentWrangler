import { Component, type ReactNode } from "react";
import AsyncErrorState, { type AsyncErrorResourceId } from "./AsyncErrorState";

interface WidgetBoundaryProps {
  children: ReactNode;
  /** Card identity: a closed AsyncErrorState resource id, so the error copy
   * always names the card (never the generic "this page" fallback). */
  label: AsyncErrorResourceId;
  /** Changing this re-renders the child fresh (for the data_version in P2). */
  resetKey?: unknown;
}

interface WidgetBoundaryState {
  failed: boolean;
}

/**
 * Isolates one Overview widget's render errors so a single bad card cannot
 * blank the whole page. Modelled on LoadBoundary, but scoped to a card
 * instead of a route: no Suspense fallback (widgets aren't lazy chunks), and
 * the failure card reserves size instead of reloading the dashboard.
 */
export default class WidgetBoundary extends Component<WidgetBoundaryProps, WidgetBoundaryState> {
  state: WidgetBoundaryState = { failed: false };

  static getDerivedStateFromError(): Partial<WidgetBoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // Stable prefix so verify:app's console gate still fails on a hidden bug.
    console.error("[widget-boundary]", this.props.label, error);
  }

  componentDidUpdate(prevProps: WidgetBoundaryProps): void {
    if (this.state.failed && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <WidgetErrorCard
          label={this.props.label}
          onRetry={() => this.setState({ failed: false })}
        />
      );
    }
    return this.props.children;
  }
}

/** The boundary's size-reserving failure card, also rendered for a section that arrived `error`. */
export function WidgetErrorCard({
  label,
  onRetry,
}: {
  label: AsyncErrorResourceId;
  onRetry: () => void;
}) {
  return (
    <div className="card" style={{ minHeight: 120 }} data-section-status="error">
      <AsyncErrorState resource={label} onRetry={onRetry} />
    </div>
  );
}

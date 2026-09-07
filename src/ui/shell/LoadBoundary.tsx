import { Component, type ReactNode, Suspense } from "react";

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
    if (this.state.failed) {
      return (
        <section role="alert">
          <p>Unable to load {label}. Reload the dashboard to try again.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload dashboard
          </button>
        </section>
      );
    }
    return <Suspense fallback={<output>Loading {label}…</output>}>{children}</Suspense>;
  }
}

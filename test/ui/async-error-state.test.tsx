import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AsyncErrorState, {
  type AsyncErrorActionId,
  type AsyncErrorResourceId,
} from "../../src/ui/shell/AsyncErrorState";

afterEach(() => {
  cleanup();
});

describe("AsyncErrorState", () => {
  it("only invokes the supplied resource retry callback", () => {
    const retryWorkspaces = vi.fn();
    render(<AsyncErrorState resource="workspaces" onRetry={retryWorkspaces} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry workspaces" }));

    expect(retryWorkspaces).toHaveBeenCalledOnce();
  });

  it("uses reader-safe copy and discloses only a sanitized technical code", () => {
    render(
      <AsyncErrorState
        resource="sessions"
        onRetry={vi.fn()}
        technicalDetail="unsafe technical detail"
      />,
    );

    expect(screen.getByText("Could not load sessions.")).toBeTruthy();
    expect(screen.queryByText("unsafe technical detail")).toBeNull();
    expect(screen.queryByText("Technical details")).toBeNull();
  });

  it("rejects hostile resource, action, and technical-detail values from rendered copy", () => {
    const retry = vi.fn();
    render(
      <AsyncErrorState
        resource={"C:/operator/private-response" as "sessions"}
        action={"Error: response body" as "retry"}
        onRetry={retry}
        technicalDetail="C:/operator/private-response"
      />,
    );

    expect(screen.getByRole("heading", { name: "Could not load this page." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry page" })).toBeTruthy();
    expect(screen.queryByText(/operator|response body/i)).toBeNull();
    expect(screen.queryByText("Technical details")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each(["__proto__", "constructor"] as const)(
    "rejects prototype key %s for resource and action copy",
    (hostileKey) => {
      const retry = vi.fn();

      expect(() =>
        render(
          <AsyncErrorState
            resource={hostileKey as AsyncErrorResourceId}
            action={hostileKey as AsyncErrorActionId}
            onRetry={retry}
          />,
        ),
      ).not.toThrow();

      expect(screen.getByRole("heading", { name: "Could not load this page." })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry page" })).toBeTruthy();
      expect(screen.queryByText(hostileKey)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
      expect(retry).toHaveBeenCalledOnce();
    },
  );

  it("shows an explicitly disclosed, bounded failure code", () => {
    render(
      <AsyncErrorState resource="judge-setup" onRetry={vi.fn()} technicalDetail="API_TIMEOUT" />,
    );

    const details = screen.getByText("Technical details").closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("Failure code: API_TIMEOUT")).toBeTruthy();
  });
});

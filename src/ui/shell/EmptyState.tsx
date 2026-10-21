/**
 * Loaded-empty onboarding state for dashboard surfaces.
 *
 * This intentionally differs from daemon-error banners: it explains a
 * successful zero-row response and never implies a failed request.
 */

export interface EmptyStateProps {
  headline: string;
  why: string;
  whatWillAppear: string;
  command?: string;
  help?: { href: string; label: string };
}

export default function EmptyState({
  headline,
  why,
  whatWillAppear,
  command,
  help,
}: EmptyStateProps) {
  const copyCommand = (commandToCopy: string) => {
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) return;
    void navigator.clipboard.writeText(commandToCopy).catch(() => undefined);
  };

  return (
    <section className="empty-state onboarding-empty-state" aria-live="polite">
      <h2>{headline}</h2>
      <p className="empty-state-text">{why}</p>
      <p className="empty-state-text">{whatWillAppear}</p>
      {help && (
        <p>
          <a href={help.href}>{help.label}</a>
        </p>
      )}
      {command !== undefined && (
        <button
          type="button"
          className="btn-secondary empty-state-command"
          onClick={() => copyCommand(command)}
          aria-label={`Copy command: ${command}`}
          title="Copy command"
        >
          <code>{command}</code>
        </button>
      )}
    </section>
  );
}

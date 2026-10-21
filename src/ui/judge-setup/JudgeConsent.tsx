import { useState } from "react";
import InfoTip from "../shell/InfoTip";
import Modal from "../shell/Modal";
import type { ReadyConsent } from "./judge-api";
import { REDACTION_SPLIT } from "./narrative";

function PayloadPreview({ payload }: { payload: string }) {
  const parts = payload.split(REDACTION_SPLIT);
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the scrollable preview must be keyboard-scrollable
    <pre className="judge-consent-payload" tabIndex={0} aria-label="Exactly what will be sent">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional split of a fixed string
          <mark key={i} className="judge-redaction" title="Removed on this machine before sending">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </pre>
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The consent screen (plan U10, R15). A native modal dialog: focus stays inside, Esc declines, and focus returns
 * to the "Judge me" button on close. Declining sends nothing.
 */
export default function JudgeConsent({
  view,
  notice,
  onApprove,
  onDecline,
  onSaveSources,
}: {
  view: ReadyConsent;
  notice: string | null;
  onApprove: (remember: boolean) => void;
  onDecline: () => void;
  onSaveSources: (names: string[], includedRepos: string[]) => Promise<boolean>;
}) {
  const [names, setNames] = useState<string[]>(view.extra_names);
  const [draft, setDraft] = useState("");
  const [included, setIncluded] = useState<string[]>(
    view.repos.filter((r) => r.included).map((r) => r.path),
  );
  const [remember, setRemember] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const savedIncluded = view.repos.filter((r) => r.included).map((r) => r.path);
  const dirty = !sameList(names, view.extra_names) || !sameList(included, savedIncluded);
  const kb = Math.max(1, Math.round(new Blob([view.payload]).size / 1024));

  const addName = () => {
    const n = draft.trim();
    if (n.length >= 2 && n.length <= 64 && !names.includes(n)) setNames([...names, n]);
    setDraft("");
  };
  const toggleRepo = (path: string) => {
    const set = new Set(included);
    if (set.has(path)) set.delete(path);
    else set.add(path);
    setIncluded(view.repos.map((r) => r.path).filter((p) => set.has(p)));
  };

  return (
    <Modal labelledBy="judge-consent-title" onCancel={onDecline}>
      <div className="judge-consent">
        <div className="judge-consent-body">
          <h2 id="judge-consent-title">Send your setup to Claude for a review?</h2>
          {notice !== null && (
            <p className="judge-banner" role="alert">
              {notice}
            </p>
          )}
          <p>
            Below is exactly what will be sent to <b>{view.model}</b> through your Claude Code
            login. Nothing leaves this machine until you click Send. Highlighted placeholders such
            as <mark className="judge-redaction">[USER]</mark> mark text removed here first;{" "}
            <code>~</code> stands for your home folder.
          </p>

          <h3>Claude Code also adds</h3>
          <ul className="judge-consent-list">
            {view.disclosures.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          {view.network_env.length > 0 && (
            <p>
              These network settings on this machine apply to the request (names only; values are
              not shown):{" "}
              {view.network_env.map((n, i) => (
                <span key={n}>
                  {i > 0 && ", "}
                  <code>{n}</code>
                </span>
              ))}
            </p>
          )}

          <h3>
            Names to remove{" "}
            <InfoTip
              label="What names to remove means"
              content="Your OS user name and git name are always removed. Add any other name that should not be sent, such as your first name or a company name. Each match is replaced with [USER]."
            />
          </h3>
          <ul className="judge-consent-names">
            {names.map((n) => (
              <li key={n} className="chip chip-plain">
                <span>{n}</span>
                <button
                  type="button"
                  className="btn-secondary judge-name-remove"
                  aria-label={`Remove ${n}`}
                  onClick={() => setNames(names.filter((x) => x !== n))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="judge-consent-add">
            <input
              type="text"
              aria-label="Add a name to remove"
              placeholder="Add a name to remove"
              value={draft}
              maxLength={64}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addName();
                }
              }}
            />
            <button type="button" className="btn-secondary" onClick={addName}>
              Add
            </button>
          </div>

          {view.repos.length > 0 && (
            <fieldset className="judge-consent-repos">
              <legend>Repos to include (their CLAUDE.md files)</legend>
              {view.repos.map((r) => (
                <label key={r.path}>
                  <input
                    type="checkbox"
                    checked={included.includes(r.path)}
                    onChange={() => toggleRepo(r.path)}
                  />{" "}
                  {r.path}
                </label>
              ))}
            </fieldset>
          )}
          <div className="judge-consent-update">
            <button
              type="button"
              className="btn-secondary"
              disabled={!dirty || saving}
              onClick={() => {
                setSaving(true);
                setSaveFailed(false);
                void onSaveSources(names, included).then((ok) => {
                  setSaving(false);
                  if (!ok) setSaveFailed(true);
                });
              }}
            >
              Update preview
            </button>
            {dirty && <span>Update the preview to see and send the edited version.</span>}
            {saveFailed && <span role="alert">Could not save the changes. Try again.</span>}
          </div>

          <h3>What will be sent ({kb} KB)</h3>
          <PayloadPreview payload={view.payload} />
        </div>

        <div className="judge-consent-foot">
          <label className="judge-consent-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />{" "}
            Don't ask again for this setup
          </label>
          <span className="judge-consent-actions">
            <button type="button" className="btn-secondary" onClick={onDecline}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={dirty || saving}
              onClick={() => onApprove(remember)}
            >
              Send to Claude
            </button>
          </span>
        </div>
      </div>
    </Modal>
  );
}

import { useEffect } from "react";
import Chip from "../shell/Chip";
import { type HelpLink, furtherReading, helpRoute, tasks, topics } from "./topics";

function Links({ links }: { links: HelpLink[] }) {
  return (
    <ul className="help-links">
      {links.map((link) => (
        <li key={link.href}>
          <a href={link.href}>{link.label}</a>
        </li>
      ))}
    </ul>
  );
}

export default function HelpPage({ hash }: { hash: string }) {
  const { topic, section } = helpRoute(hash);
  useEffect(() => {
    const { section } = helpRoute(hash);
    const target = document.getElementById(section ? `help-${section}` : "help-title");
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "start" });
  }, [hash]);

  return (
    <div className="help-page">
      <div className="page-top">
        <div>
          {topic && <a href="#/help">All Help topics</a>}
          <h1 className="page-title" id="help-title" tabIndex={-1}>
            {topic?.title ?? "Help"}
          </h1>
          <p className="page-sub">
            {topic?.summary ??
              "Understand your activity, investigate a problem, or find your next step."}
          </p>
        </div>
      </div>
      {topic ? (
        <div className="help-layout">
          <nav className="card help-contents" aria-label="On this page">
            <h2>On this page</h2>
            <ul>
              {topic.sections.map((item) => (
                <li key={item.id}>
                  <a
                    href={`#/help?topic=${topic.id}&section=${item.id}`}
                    aria-current={section === item.id ? "location" : undefined}
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.ctrlKey ||
                        event.metaKey ||
                        event.altKey ||
                        event.shiftKey
                      )
                        return;
                      // Native links retain modified-click behavior; same-URL activation still focuses.
                      if (window.location.hash === `#/help?topic=${topic.id}&section=${item.id}`) {
                        document.getElementById(`help-${item.id}`)?.focus();
                      }
                    }}
                  >
                    {item.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <article className="help-article">
            {topic.sections.map((item) => (
              <section className="card" key={item.id} aria-labelledby={`help-${item.id}`}>
                <h2 id={`help-${item.id}`} tabIndex={-1}>
                  {item.title}
                </h2>
                {item.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
                {item.steps && (
                  <ol>
                    {item.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                )}
                {item.links && <Links links={item.links} />}
              </section>
            ))}
          </article>
        </div>
      ) : (
        <>
          <section className="card help-start" aria-labelledby="help-start">
            <div>
              <p className="help-eyebrow">Your first visit</p>
              <h2 id="help-start">Start with your own activity</h2>
              <p>
                Check ingestion, choose a window, and explore a session. Optional setup can wait.
              </p>
            </div>
            <a className="btn-primary" href="#/help?topic=getting-started">
              Start here
            </a>
          </section>
          <section aria-labelledby="help-tasks">
            <h2 id="help-tasks">What would you like to do?</h2>
            <div className="help-grid">
              {tasks.map((task) => (
                <a className="card help-task" href={task.href} key={task.href}>
                  {task.label}
                  <span aria-hidden="true"> →</span>
                </a>
              ))}
            </div>
          </section>
          <section className="card" aria-labelledby="help-explore">
            <h2 id="help-explore">Explore the dashboard</h2>
            <div className="help-grid">
              {[
                { name: "Observe", ids: ["overview", "workspaces", "sessions"] },
                { name: "Analyze", ids: ["judge-setup", "diagnostics", "recommendations"] },
                { name: "Configure", ids: ["settings"] },
              ].map((group) => (
                <div key={group.name}>
                  <h3>{group.name}</h3>
                  <Links
                    links={group.ids.map((id) => ({
                      label: topics.find((item) => item.id === id)?.title ?? id,
                      href: `#/help?topic=${id}`,
                    }))}
                  />
                </div>
              ))}
            </div>
          </section>
          <div className="help-grid help-resources">
            <section className="card">
              <h2>Follow a walkthrough</h2>
              <p>Inspect a costly session, investigate a pattern, or review a supported change.</p>
              <a href="#/help?topic=walkthroughs">Choose a walkthrough</a>
            </section>
            <section className="card">
              <h2>Troubleshooting</h2>
              <p>Missing data, unavailable panels, scan status, restart and recovery.</p>
              <a href="#/help?topic=troubleshooting">Find a next step</a>
            </section>
            <section className="card">
              <h2>Understand the numbers</h2>
              <p>
                <Chip kind="EXACT" /> <Chip kind="MODELED" /> Read evidence labels with their
                definitions.
              </p>
              <a href="#/glossary">How to read this dashboard</a>
            </section>
            <section className="card">
              <h2>Optional setup and privacy</h2>
              <p>Scan roots, calibration, guards, GitHub outcomes and local data.</p>
              <a href="#/help?topic=setup">Review setup and privacy</a>
            </section>
          </div>
          <section className="card">
            <h2>More help</h2>
            <p>
              External documentation may describe a different release. Review reports for local
              identifiers and sensitive content before sharing.
            </p>
            <Links links={furtherReading} />
          </section>
        </>
      )}
    </div>
  );
}

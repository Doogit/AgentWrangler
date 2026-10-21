/** Bundled Help facts. Also rendered to docs/help/guide.md; no network content loader. */
export interface HelpLink {
  label: string;
  href: string;
}
export interface HelpSection {
  id: string;
  title: string;
  paragraphs: string[];
  steps?: string[];
  links?: HelpLink[];
}
export interface HelpTopic {
  id: string;
  title: string;
  summary: string;
  sections: HelpSection[];
}
const app = (label: string, route: string): HelpLink => ({ label, href: `#/${route}` });
const guide = (label: string, topic: string): HelpLink => app(label, `help?topic=${topic}`);
export const furtherReading = [
  {
    label: "Getting Started (external)",
    href: "https://github.com/Doogit/AgentWrangler/blob/main/docs/getting-started.md",
  },
  {
    label: "Dashboard Tour (external)",
    href: "https://github.com/Doogit/AgentWrangler/blob/main/docs/dashboard-tour.md",
  },
  {
    label: "Privacy (external)",
    href: "https://github.com/Doogit/AgentWrangler/blob/main/docs/privacy.md",
  },
  { label: "Report an issue (external)", href: "https://github.com/Doogit/AgentWrangler/issues" },
] satisfies [HelpLink, HelpLink, HelpLink, HelpLink];
export const topics: HelpTopic[] = [
  {
    id: "getting-started",
    title: "Start here",
    summary: "Find your first useful insight, with no optional setup required.",
    sections: [
      {
        id: "first-visit",
        title: "Your first visit",
        paragraphs: [
          "You need a running daemon and local Claude Code history. You can finish this path without a GitHub token, calibration, guards or a tracked recommendation.",
        ],
        steps: [
          "Open Overview and check the scan state. A running scan means totals can still change; it is separate from the first-ingest checklist.",
          "Choose a date window with activity. Read the evidence labels alongside the totals before comparing spend.",
          "Open Workspaces or Sessions and choose an entry. The detail view helps explain which activity contributed to the total.",
          "Return to Overview. If a recommendation is available, review its evidence; otherwise, exploring your history is a complete first visit.",
        ],
        links: [
          app("Open Overview", "overview"),
          app("Open Workspaces", "workspaces"),
          app("Open Sessions", "sessions"),
        ],
      },
      {
        id: "no-history",
        title: "If there is nothing to explore",
        paragraphs: [
          "A completed scan with no history is different from a failed request. Check the date window and scan roots before changing settings. An unavailable page should show its error or retry guidance; an empty list alone does not prove ingestion failed.",
        ],
        links: [guide("Fix missing data", "troubleshooting")],
      },
      {
        id: "labels",
        title: "Read the labels with the numbers",
        paragraphs: [
          "Cost equivalents and projected opportunities are not a bill or a promise of savings. Use the existing metric reference for definitions, units and evidence labels.",
        ],
        links: [app("How to read this dashboard", "glossary")],
      },
    ],
  },
  {
    id: "overview",
    title: "Overview",
    summary: "Check ingestion, spend and where to investigate next.",
    sections: [
      {
        id: "read",
        title: "Read the overview",
        paragraphs: [
          "Start with some ingested activity. Usage and forecast panels have additional prerequisites and may be unavailable even when session history is present. The usage limits card needs claude on your PATH and new enough to support /usage; the reader can also be turned off in Settings.",
        ],
        steps: [
          "Check the scan state to see whether the initial background scan is still running.",
          "Choose the date window and compare the totals with their labels. The expensive-session list uses a fixed seven-day window and shows up to five sessions.",
          "Open a costly session to inspect its drivers. Quantified recommendations are a separate panel, with up to three cards.",
          "Read any usage or forecast unavailable reason before opting into setup. For usage limits the reason is usually that claude is not on PATH, is too old for /usage, or the reader is off in Settings.",
        ],
        links: [
          app("Open Overview", "overview"),
          guide("Inspect an expensive session", "walkthroughs"),
        ],
      },
      {
        id: "unavailable",
        title: "Empty or unavailable panels",
        paragraphs: [
          "No recommendations can be a valid result. A scan in progress, no qualifying activity, missing usage data and a failed request need different responses. Check the panel message rather than treating every blank value as zero.",
        ],
        links: [guide("Troubleshooting", "troubleshooting"), app("Metric reference", "glossary")],
      },
    ],
  },
  {
    id: "workspaces",
    title: "Workspaces",
    summary: "Compare projects, then inspect the sessions behind them.",
    sections: [
      {
        id: "compare",
        title: "Compare workspace activity",
        paragraphs: [
          "You need activity associated with a workspace in the selected window. Transient workspaces can represent temporary checkouts; review the identity before assuming they are separate long-lived projects.",
        ],
        steps: [
          "Open Workspaces and choose a date window with activity.",
          "Compare spend and Premium %. Premium includes Opus, Fable and Mythos; it is not an Opus-only share.",
          "Choose a workspace to inspect its detail and sessions.",
          "Open a session to investigate a contributor. Treat missing outcome data as unavailable evidence, not proof of no useful work.",
        ],
        links: [app("Open Workspaces", "workspaces"), guide("Sessions guide", "sessions")],
      },
      {
        id: "empty",
        title: "No matching workspaces",
        paragraphs: [
          "Widen the date window and check scan roots if history is missing. GitHub outcomes are optional and require separate setup; workspace spend does not require them.",
        ],
        links: [
          guide("Optional setup and privacy", "setup"),
          guide("Troubleshooting", "troubleshooting"),
        ],
      },
    ],
  },
  {
    id: "sessions",
    title: "Sessions",
    summary: "Find costly activity and inspect its timeline and cost drivers.",
    sections: [
      {
        id: "inspect",
        title: "Inspect a session",
        paragraphs: [
          "Start with ingested sessions in the selected window. Live and partial evidence can change as ingestion completes.",
        ],
        steps: [
          "Open Sessions and use the available date and filter controls to find the activity you want.",
          "Compare cache hit, peak context, subagent cost and cost/turn alongside duration, models, turns and issues.",
          "Choose a session to see its timeline and cost drivers. Friction information belongs to the detail view.",
          "Follow an available diagnostic turn link to inspect the affected turn; a turn link is only present when an anchor is available.",
        ],
        links: [app("Open Sessions", "sessions"), app("Open Usage patterns", "diagnostics")],
      },
      {
        id: "interpret",
        title: "Interpret the evidence",
        paragraphs: [
          "Affected-turn cost describes observed activity. It does not tell you how much a future change will save. Empty results may reflect the window or filters; failed requests need the page's retry path.",
        ],
        links: [app("Metric reference", "glossary"), guide("Fix missing data", "troubleshooting")],
      },
    ],
  },
  {
    id: "judge-setup",
    title: "Rate my setup",
    summary: "Grade your Claude Code configuration and habits, and see what to fix next.",
    sections: [
      {
        id: "grade",
        title: "Read your setup grade",
        paragraphs: [
          "The grade combines your settings with what your recent sessions show. A check without enough data is left out of the score; it is not counted as a failure.",
        ],
        steps: [
          "Open Rate my setup from the sidebar, or from the Rate my setup card on Overview, which shows the same score, tier and next step. Read the tier and overall score at the top.",
          "If a cap or gate holds the tier down, read its reason first; the score before the cap is shown beside it.",
          "Open a category's checks to see each result, what it needs, and a link to the fix or the cited doc.",
          "Dollar figures appear only where a recommendation prices the gap. The next-tier total says when it counts measured items only.",
        ],
        links: [
          app("Open Rate my setup", "judge-setup"),
          app("Overview", "overview"),
          guide("Evaluate a recommendation", "recommendations"),
        ],
      },
      {
        id: "ai-review",
        title: "Get an AI review (optional)",
        paragraphs: [
          "Judge me asks Claude to read a summary of your setup and say what the checks miss. It runs one request through your own claude CLI and login, and counts toward your plan's usage. Nothing is sent until you approve.",
        ],
        steps: [
          "Click Judge me under Written review.",
          "Read the consent screen. It shows the exact text that will be sent, with your user and git names, email addresses, URLs and host names redacted. Add names to remove or untick repos, then click Update preview.",
          "Click Send to Claude, or Cancel to send nothing. While it runs you can cancel the review.",
          "Read the result as AI opinion (unverified). It never changes your score or tier; where it disagrees with a check, the check row says so.",
        ],
        links: [app("Open Rate my setup", "judge-setup")],
      },
      {
        id: "missing",
        title: "When there is no tier or no score",
        paragraphs: [
          "A fresh install usually has no tier yet because too little of the rubric has data. The page lists what it needs. Copy summary puts text on your clipboard with your tier and scores, never paths, workspace names or config text.",
        ],
        links: [app("Metric reference", "glossary")],
      },
    ],
  },
  {
    id: "recommendations",
    title: "Recommendations",
    summary: "Separate a suggestion, a completed change and an observed effect.",
    sections: [
      {
        id: "review",
        title: "Review before changing anything",
        paragraphs: [
          "Recommendations require qualifying evidence. The dollar figure on each card is an estimate, or reads Not estimated; it does not promise a result. Ranking considers measured effects, usage estimates and safety risk.",
        ],
        steps: [
          "Open Recommendations and read the card's scope, evidence window and caveats.",
          "Follow linked sessions. Where a full session count is available, the links show at most five examples. An unavailable count remains unknown.",
          "Inspect the action and any preview. Copy prompt copies instructions; it does not apply a change. Open in Claude Code (shown only after Settings > Advanced > Experimental actions is turned on) starts your own claude in a terminal; review what it will do before you run it. AgentWrangler applies nothing for you.",
          "If the card offers Track, complete the real change and its confirmation flow. Manual-evidence paths can require a separate attestation. Controls vary with validation and tracking eligibility.",
        ],
        links: [
          app("Open Recommendations", "recommendations"),
          app("Metric reference", "glossary"),
        ],
      },
      {
        id: "measurement",
        title: "Return to inspect measurement",
        paragraphs: [
          "Open the Impact ledger within Recommendations on a later visit. The observation window is 14 days; elapsed time alone does not guarantee enough comparable data. Pending, inconclusive or unsupported results are not measured savings.",
          "Shell-error guidance is scoped to a workspace. Its measurement combines Bash and PowerShell calls so a shell switch can be observed. Same-error-loop measurement counts loops per 100 eligible sessions; its advisory cost context must not be added to other savings totals.",
          "Stop measurement stops tracking. Manual-revert attestation records that you reverted a change yourself; neither control automatically restores files. Review your own diff or backup to reverse a change safely.",
        ],
        links: [app("Open Recommendations and Impact ledger", "recommendations")],
      },
      {
        id: "unavailable",
        title: "No recommendation or action",
        paragraphs: [
          "No card may mean no detector met its evidence threshold. An available method alone does not make every card trackable: source identity, a supported target metric and validation still matter. Missing Copy prompt or Track controls are not instructions to bypass validation.",
          "Compare each card's assumptions and exposure. There is no universal cache-miss-versus-memory-trim savings ratio. Source-file token quantities may be estimates.",
        ],
        links: [guide("Troubleshooting", "troubleshooting")],
      },
    ],
  },
  {
    id: "diagnostics",
    title: "Usage patterns",
    summary: "See what is costing you, why it happens, and which causes have a fix.",
    sections: [
      {
        id: "investigate",
        title: "Follow a pattern to its evidence",
        paragraphs: [
          "Usage patterns needs parsed activity in the selected scope. It helps locate a pattern, not establish that every affected turn was avoidable.",
        ],
        steps: [
          "Open Usage patterns and pick a window (7d, 14d or 30d). Read the tiles, then the Avoidable spend and Reliability causes.",
          "Expand a cause to see when it happens, an example and its affected sessions, then open an affected session.",
          "Follow a turn anchor when available to inspect the contributing activity.",
          "Check the surrounding context before choosing a repair. A denial can reflect an intended guard.",
        ],
        links: [
          app("Open Usage patterns", "diagnostics"),
          guide("Investigation walkthroughs", "walkthroughs"),
        ],
      },
      {
        id: "caveats",
        title: "No findings and cost caveats",
        paragraphs: [
          "No findings can be valid for the selected activity. Missing parser coverage is a separate concern. Affected-turn cost is observed context, not forecast savings. Inspect retained command/error text locally; avoid copying it into reports.",
        ],
        links: [
          app("Open Parser Health", "settings?section=parser-health"),
          guide("Privacy and setup", "setup"),
        ],
      },
    ],
  },
  {
    id: "settings",
    title: "Settings",
    summary: "Understand essentials, guards, integrations and advanced diagnostics.",
    sections: [
      {
        id: "configure",
        title: "Choose a setting deliberately",
        paragraphs: [
          "Opening Settings does not require you to enable optional features. Reading Help never saves settings or installs hooks.",
        ],
        steps: [
          "Check scan roots under Essentials if data is missing. Save intended roots and restart the daemon for them to take effect.",
          "Review calibration only if you want to provide its additional usage inputs. Bytes calibration uses your effective configured scan roots, including defaults; an explicitly saved empty list stays empty. Insufficient samples can still occur.",
          "Open In-session guards to review installation and removal controls before changing Claude Code hooks.",
          "Read Outcomes sync status under integrations. Advanced and diagnostics contains Parser Health and Parse Failures.",
        ],
        links: [
          app("Open Settings", "settings"),
          app("Scan roots", "settings?section=scan-roots"),
          app("Usage calibration", "settings?section=calibration"),
          app("In-session guards", "settings?section=in-session-guards"),
          app("Outcomes sync", "settings?section=outcomes-sync"),
          app("Parser Health", "settings?section=parser-health"),
        ],
      },
      {
        id: "limits",
        title: "Known limitations",
        paragraphs: [
          "Token presence is not proof of connectivity. Settings offers external credential setup guidance, local status refresh, an explicit connection test and sync retry. Sync history covers only this daemon run; a prior success does not certify the current credential. Parser Health reports counts: no parser data, quarantined lines detected, or no quarantined lines. A quarantine rate is unavailable because files and lines are different units.",
        ],
        links: [guide("Setup and privacy", "setup"), guide("Troubleshooting", "troubleshooting")],
      },
    ],
  },
  {
    id: "walkthroughs",
    title: "Follow a walkthrough",
    summary: "Self-paced steps using your chosen activity; no automatic changes.",
    sections: [
      {
        id: "expensive-session",
        title: "Inspect an expensive session",
        paragraphs: [
          "Prerequisite: at least one ingested session. This ends with an explanation, not a required optimization.",
        ],
        steps: [
          "Open Sessions and choose a window with activity; locate a high-cost session.",
          "Choose it and compare its timeline, peak context and subagent contribution. Identify which driver explains the total.",
          "Read the evidence label and metric reference. Record a question to investigate, or stop if the activity was expected.",
        ],
        links: [app("Open Sessions", "sessions"), app("Metric reference", "glossary")],
      },
      {
        id: "diagnostic-pattern",
        title: "Investigate a recurring problem",
        paragraphs: [
          "Prerequisite: a diagnostic finding. If none is present, there is no task to complete here.",
        ],
        steps: [
          "Open Usage patterns and expand the relevant cause under Avoidable spend or Reliability.",
          "Open an affected session and follow an available turn link. You should arrive at the relevant activity, or at session detail if no anchor exists.",
          "Check whether the pattern reflects a problem or an intended guard. Decide on a repair only after reviewing context.",
        ],
        links: [app("Open Usage patterns", "diagnostics")],
      },
      {
        id: "tracked-change",
        title: "Make a supported change, then return",
        paragraphs: [
          "Prerequisite: a recommendation with a validated action and eligible tracking. You can review a card without adopting it.",
        ],
        steps: [
          "Open Recommendations, inspect evidence and preview the proposed action. Confirm it fits the selected workspace.",
          "Copy the prompt (or use Open in Claude Code if you turned it on), make the change yourself, and verify the actual change. Copying alone is not completion.",
          "Use Track and complete the confirmation or manual attestation offered by that card. If unavailable, do not invent a tracking path.",
          "Return later to the Impact ledger in Recommendations. Read observation and comparability reasons; the 14-day window may still produce an inconclusive result.",
        ],
        links: [
          app("Open Recommendations", "recommendations"),
          guide("Measurement and reversal caveats", "recommendations"),
        ],
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    summary: "Distinguish missing history, valid empty results and failed requests.",
    sections: [
      {
        id: "missing-data",
        title: "Missing or incomplete history",
        paragraphs: [
          "Scan still running: check Overview's scan state and allow the background scan to finish. Totals can change during ingestion. The dismissible pipeline banner is not a permanent last-ingest record.",
          "Scan complete, no history: check the selected dates, filters and saved scan roots. Confirm the directory contains the Claude Code history you intended to scan; save corrected roots and restart.",
          "Parse problems: open Parser Health and inspect quarantine counts and Parse Failures. The count-based status does not estimate a quarantine percentage or establish that every record parsed correctly. A request error requires recovery through the page's error/retry guidance, not interpretation as an empty dataset.",
        ],
        links: [
          app("Open Overview", "overview"),
          app("Scan roots", "settings?section=scan-roots"),
          app("Parser Health", "settings?section=parser-health"),
        ],
      },
      {
        id: "optional-data",
        title: "Missing recommendations, outcomes or forecast",
        paragraphs: [
          "No recommendations: inspect scope and evidence availability. Detectors can legitimately have no qualifying findings. You do not need to enable integrations to finish your first visit.",
          "Missing GitHub outcomes: configured means a token is present, not that it is valid or authorized for a repository. The daemon also needs gh. Use the explicit connection test or sync retry in Settings. A test proves only its read-only calls against a locally known repository, not every sync capability. With no eligible repository, access remains untested. A successful sync can legitimately find no matching outcomes.",
          "Credential status unavailable: use Retry status. After changing or removing the Windows credential, use the local credential recheck to clear the local cache. Restart after changing the daemon environment. Local refresh does not contact GitHub or certify access.",
          "Usage or forecast unavailable: read the panel's prerequisite message and, if appropriate, review usage calibration. For usage limits, claude must be on your PATH and new enough to support /usage, and the Read usage via Claude Code /usage checkbox must not be turned off in Settings (Settings > Usage limits from Claude Code). The statusline is an alternative source. Historical spend alone does not establish current account usage. Insufficient calibration samples can be a valid result.",
        ],
        links: [
          app("Outcomes sync", "settings?section=outcomes-sync"),
          app("Usage calibration", "settings?section=calibration"),
        ],
      },
      {
        id: "daemon",
        title: "Daemon unavailable, update or port conflict",
        paragraphs: [
          "If this page is already loaded it can remain readable after an analytics failure. A stopped daemon cannot serve a fresh dashboard page. Once the shell loads, the status chip at the top of each page shows startup progress; if the dashboard is not ready after 30 seconds, its popover shows recovery steps. Keep the repository's Getting Started guide or the generated Help Markdown available outside the dashboard.",
          "For an installed package, start agentwrangler (or npx agentwrangler@latest). For a source checkout with dependencies installed, use npm run daemon. The default address is http://127.0.0.1:2929.",
          "Stop the existing daemon before updating or restarting. Do not start a second instance on the same port. For a source UI change run npm run build:ui before restarting; use npm run build for daemon and UI changes. Reopen the dashboard and use Retry connection if shown.",
          "If the port is occupied, identify its owner first. Reuse or stop your existing instance, or configure AW_PORT for a separate instance. Do not terminate an unrelated process. Node must satisfy the package engine range, currently >=22 <25.",
        ],
        links: [furtherReading[0]],
      },
    ],
  },
  {
    id: "setup",
    title: "Optional setup and privacy",
    summary: "Know what is stored and which integrations you are enabling.",
    sections: [
      {
        id: "optional",
        title: "Optional setup",
        paragraphs: [
          "Scan roots are restart-loaded. Weekly calibration and optional bytes calibration have their own inputs and sample requirements; neither is required to browse history. Bytes calibration shares the effective scan roots used by Settings and ingestion; explicit empty roots do not fall back to broader defaults.",
          "Guards modify Claude Code hook configuration when installed. Review the available direct installation or copied-prompt flow and its removal instructions. Direct installation covers five hooks; the prompt flow covers three. Do not assume the two flows install identical coverage.",
          "On macOS, Open in Claude Code opens Terminal.app through osascript, so macOS asks once for Automation permission. The sign-in check (GET /api/oauth/status) reads the Claude Code login only to report signed-in and plan tier, and macOS may show a Keychain access prompt for it; the token is never returned, logged, stored or sent. ANTHROPIC_API_KEY is removed from every claude AgentWrangler starts, so those runs use your Claude subscription login.",
        ],
        links: [
          app("Scan roots", "settings?section=scan-roots"),
          app("Usage calibration", "settings?section=calibration"),
          app("In-session guards", "settings?section=in-session-guards"),
        ],
      },
      {
        id: "github",
        title: "GitHub outcomes prerequisites",
        paragraphs: [
          "Provision an appropriate token externally as AW_GITHUB_TOKEN in the environment of the daemon process. On Windows, the fallback is Generic Credential AgentWrangler-GithubToken; other platforms do not have that native credential-store fallback. The environment takes precedence. The daemon uses gh with this token; gh auth login alone does not replace this path.",
          "Settings guides setup, replacement and removal in Windows Credential Manager; it never accepts or stores a secret itself. Canceling that external workflow leaves configuration unchanged. Use the local credential recheck after changing the Windows credential; AW_GITHUB_TOKEN still takes precedence, so deleting the OS credential may leave outcomes configured. Removing a credential does not erase historical outcomes. Never paste a token into an issue or screenshot.",
          "Fine-grained access depends on each endpoint: pull-request reads and check-run reads use different permissions, and GraphQL access depends on the requested resources. See https://github.com/Doogit/AgentWrangler/blob/main/docs/help/github-permissions.md for the official endpoint inventory. Organization policy or token approval may also limit access. A forbidden or not-found response does not establish a single cause.",
        ],
        links: [app("Outcomes sync status", "settings?section=outcomes-sync")],
      },
      {
        id: "privacy",
        title: "Local does not mean content-free",
        paragraphs: [
          "The dashboard binds to loopback and uses local storage. By default the only outbound call is your own claude CLI's /usage, run in the background only while the dashboard is open (at most every 5 minutes when you are active, hourly when idle). AgentWrangler never reads your Claude login for it. You can turn it off in Settings or use the Claude Code statusline instead. Optional GitHub outcomes, the Rate my setup AI review and bytes calibration are opt-in and also involve outbound requests. Review the privacy guide before enabling an integration.",
          "Ingestion can retain filtered shell-command and errored-tool-result slices, capped at 4,000 characters each. Filtering is best effort and cannot guarantee removal of secrets. Treat the local database as sensitive.",
          "Optional PreCompact checkpoint copies contain raw transcript data and have separate retention and cleanup. Uninstalling hooks or the package does not by itself remove those copies. Do not share transcripts, database dumps, local paths or raw command/error evidence in a bug report.",
        ],
        links: [furtherReading[2]],
      },
    ],
  },
];

export const tasks = [
  guide("Find expensive activity", "sessions"),
  guide("Investigate a recurring problem", "diagnostics"),
  guide("Evaluate a recommendation", "recommendations"),
  { label: "Check a tracked change", href: "#/help?topic=recommendations&section=measurement" },
  guide("Rate my setup", "judge-setup"),
  guide("Fix missing data", "troubleshooting"),
];
export function helpRoute(hash: string): {
  topic: HelpTopic | undefined;
  section: string | undefined;
} {
  const params = new URLSearchParams(hash.split("?")[1] ?? "");
  const topic = topics.find((item) => item.id === params.get("topic"));
  return { topic, section: topic?.sections.find((item) => item.id === params.get("section"))?.id };
}

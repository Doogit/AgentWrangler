import { readFileSync, writeFileSync } from "node:fs";
import { furtherReading, topics } from "../src/ui/help/topics.ts";

const link = ({ label, href }) => {
  if (!href.startsWith("#/")) return `[${label}](${href})`;
  if (href.startsWith("#/help?")) {
    const params = new URLSearchParams(href.split("?")[1]);
    return `[${label}](#${params.get("topic")}${params.has("section") ? `-${params.get("section")}` : ""})`;
  }
  return `${label}: dashboard route \`${href}\``;
};
const blocks = [
  "# AgentWrangler Help",
  "Generated from `src/ui/help/topics.ts`. Regenerate with `node --import tsx/esm scripts/generate-help.mjs`; add `--check` to verify parity. This file is generated from the in-app Help and matches this version.",
  "Dashboard routes below are for the running app. Installation and recovery text remains readable here when the daemon is stopped.",
  topics.map((topic) => `[${topic.title}](#${topic.id})`).join(" · "),
];
for (const topic of topics) {
  blocks.push(`<a id="${topic.id}"></a>\n\n## ${topic.title}`, topic.summary);
  for (const section of topic.sections) {
    blocks.push(
      `<a id="${topic.id}-${section.id}"></a>\n\n### ${section.title}`,
      ...section.paragraphs,
    );
    if (section.steps) blocks.push(section.steps.map((step, i) => `${i + 1}. ${step}`).join("\n"));
    if (section.links) blocks.push(section.links.map((item) => `- ${link(item)}`).join("\n"));
  }
}
blocks.push("## More help", furtherReading.map((item) => `- ${link(item)}`).join("\n"));
const content = `${blocks.join("\n\n")}\n`;
const destination = new URL("../docs/help/guide.md", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8").replace(/\r\n/g, "\n") !== content) {
    throw new Error("Generated Help differs; regenerate docs/help/guide.md");
  }
  console.log("PASS: generated Help matches bundled topics");
} else {
  writeFileSync(destination, content);
  console.log("Generated docs/help/guide.md");
}
